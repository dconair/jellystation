//! Hilfen nur für Tests: ein kleiner ISO-9660-Schreiber, `PARAM.SFO`, ein Wegwerf-Ordner und ein
//! Mock-HTTP-Server, der die libretro-Thumbnails nachstellt.

use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/* ------------------------------------------------------------------------------- Wegwerf-Ordner */

/// Ordner unter dem Temp-Verzeichnis, der beim Ende des Tests verschwindet.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(name: &str) -> TempDir {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "js-covers-{name}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/* ------------------------------------------------------------------------------------ ISO 9660 */

pub enum Item {
    File(String, Vec<u8>),
    Dir(String, Vec<Item>),
}

pub fn file(name: &str, data: impl Into<Vec<u8>>) -> Item {
    Item::File(name.to_string(), data.into())
}

pub fn dir(name: &str, items: Vec<Item>) -> Item {
    Item::Dir(name.to_string(), items)
}

const SECTOR: usize = 2048;

fn rec_len(name_len: usize) -> usize {
    let len = 33 + name_len;
    len + (len & 1)
}

fn record(name: &[u8], lba: u32, size: u32, is_dir: bool) -> Vec<u8> {
    let mut r = vec![0u8; rec_len(name.len())];
    r[0] = r.len() as u8;
    r[2..6].copy_from_slice(&lba.to_le_bytes());
    r[6..10].copy_from_slice(&lba.to_be_bytes());
    r[10..14].copy_from_slice(&size.to_le_bytes());
    r[14..18].copy_from_slice(&size.to_be_bytes());
    r[25] = if is_dir { 2 } else { 0 };
    r[28..30].copy_from_slice(&1u16.to_le_bytes());
    r[30..32].copy_from_slice(&1u16.to_be_bytes());
    r[32] = name.len() as u8;
    r[33..33 + name.len()].copy_from_slice(name);
    r
}

/// Verzeichnisdaten: Einträge überspannen keine Sektorgrenze, der Rest des Sektors bleibt leer.
fn pack(records: &[Vec<u8>]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    for rec in records {
        let used = out.len() % SECTOR;
        if used + rec.len() > SECTOR {
            out.resize(out.len() + SECTOR - used, 0);
        }
        out.extend_from_slice(rec);
    }
    out.resize(out.len().div_ceil(SECTOR).max(1) * SECTOR, 0);
    out
}

fn item_name(item: &Item) -> Vec<u8> {
    match item {
        Item::File(name, _) => format!("{name};1").into_bytes(),
        Item::Dir(name, _) => name.clone().into_bytes(),
    }
}

fn dir_len(items: &[Item]) -> usize {
    let mut records = vec![record(&[0], 0, 0, true), record(&[1], 0, 0, true)];
    records.extend(items.iter().map(|i| record(&item_name(i), 0, 0, true)));
    pack(&records).len()
}

struct Builder {
    extents: Vec<(u32, Vec<u8>)>,
    next: u32,
}

impl Builder {
    fn alloc(&mut self, bytes: usize) -> u32 {
        let lba = self.next;
        self.next += bytes.div_ceil(SECTOR).max(1) as u32;
        lba
    }

    fn place(&mut self, items: &[Item], self_lba: u32, parent_lba: u32) {
        let size = dir_len(items) as u32;
        let mut records = vec![
            record(&[0], self_lba, size, true),
            record(&[1], parent_lba, size, true),
        ];
        let mut subdirs = Vec::new();
        for item in items {
            match item {
                Item::File(_, data) => {
                    let lba = self.alloc(data.len());
                    self.extents.push((lba, data.clone()));
                    records.push(record(&item_name(item), lba, data.len() as u32, false));
                }
                Item::Dir(_, children) => {
                    let child_size = dir_len(children);
                    let lba = self.alloc(child_size);
                    records.push(record(&item_name(item), lba, child_size as u32, true));
                    subdirs.push((children, lba));
                }
            }
        }
        self.extents.push((self_lba, pack(&records)));
        for (children, lba) in subdirs {
            self.place(children, lba, self_lba);
        }
    }
}

/// Baut ein ISO-9660-Abbild mit 2048-Byte-Sektoren.
pub fn build_iso(items: Vec<Item>) -> Vec<u8> {
    let mut builder = Builder {
        extents: Vec::new(),
        next: 18,
    };
    let root_size = dir_len(&items);
    let root_lba = builder.alloc(root_size);
    builder.place(&items, root_lba, root_lba);

    let mut image = vec![0u8; builder.next as usize * SECTOR];
    let pvd = 16 * SECTOR;
    image[pvd] = 1;
    image[pvd + 1..pvd + 6].copy_from_slice(b"CD001");
    image[pvd + 6] = 1;
    image[pvd + 40..pvd + 72].fill(b' ');
    image[pvd + 80..pvd + 84].copy_from_slice(&builder.next.to_le_bytes());
    image[pvd + 84..pvd + 88].copy_from_slice(&builder.next.to_be_bytes());
    image[pvd + 128..pvd + 130].copy_from_slice(&(SECTOR as u16).to_le_bytes());
    image[pvd + 130..pvd + 132].copy_from_slice(&(SECTOR as u16).to_be_bytes());
    let root = record(&[0], root_lba, root_size as u32, true);
    image[pvd + 156..pvd + 156 + root.len()].copy_from_slice(&root);
    let end = 17 * SECTOR;
    image[end] = 255;
    image[end + 1..end + 6].copy_from_slice(b"CD001");
    image[end + 6] = 1;

    for (lba, data) in builder.extents {
        let at = lba as usize * SECTOR;
        image[at..at + data.len()].copy_from_slice(&data);
    }
    image
}

/// Packt ein 2048-Byte-Abbild in rohe 2352-Byte-Sektoren (Mode 1 oder Mode 2 Form 1).
pub fn raw_wrap(iso: &[u8], mode2: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(iso.len() / SECTOR * 2352);
    for (i, sector) in iso.chunks(SECTOR).enumerate() {
        let mut raw = vec![0u8; 2352];
        raw[1..11].fill(0xff);
        raw[12] = 0;
        raw[13] = 2;
        raw[14] = (i / 75) as u8;
        raw[15] = if mode2 { 2 } else { 1 };
        let start = if mode2 {
            raw[16..24].copy_from_slice(&[0, 0, 8, 0, 0, 0, 8, 0]);
            24
        } else {
            16
        };
        raw[start..start + sector.len()].copy_from_slice(sector);
        out.extend_from_slice(&raw);
    }
    out
}

/* --------------------------------------------------------------------------------- PARAM.SFO */

pub enum Sfo<'a> {
    Text(&'a str),
    Int(u32),
}

pub fn sfo(entries: &[(&str, Sfo)]) -> Vec<u8> {
    let key_table = 20 + entries.len() * 16;
    let (mut keys, mut data, mut index) = (Vec::new(), Vec::new(), Vec::new());
    for (key, value) in entries {
        let key_off = keys.len() as u16;
        keys.extend_from_slice(key.as_bytes());
        keys.push(0);
        let data_off = data.len() as u32;
        let (format, used, max) = match value {
            Sfo::Text(text) => {
                data.extend_from_slice(text.as_bytes());
                data.push(0);
                let used = text.len() + 1;
                let max = used.div_ceil(4) * 4;
                data.resize(data_off as usize + max, 0);
                (0x0204u16, used, max)
            }
            Sfo::Int(n) => {
                data.extend_from_slice(&n.to_le_bytes());
                (0x0404u16, 4, 4)
            }
        };
        index.extend_from_slice(&key_off.to_le_bytes());
        index.extend_from_slice(&format.to_le_bytes());
        index.extend_from_slice(&(used as u32).to_le_bytes());
        index.extend_from_slice(&(max as u32).to_le_bytes());
        index.extend_from_slice(&data_off.to_le_bytes());
    }
    while keys.len() % 4 != 0 {
        keys.push(0);
    }
    let data_table = key_table + keys.len();
    let mut out = b"\0PSF\x01\x01\0\0".to_vec();
    out.extend_from_slice(&(key_table as u32).to_le_bytes());
    out.extend_from_slice(&(data_table as u32).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    out.extend(index);
    out.extend(keys);
    out.extend(data);
    out
}

/// Daten, die wie ein verschlüsselter Bereich eines PS3-Abbilds aussehen.
pub fn noise(len: usize, seed: u32) -> Vec<u8> {
    let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(12345);
    (0..len)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 24) as u8
        })
        .collect()
}

/* ----------------------------------------------------------------------- Sehr große, dünne Datei */

/// Tut so, als wäre das Abbild `len` Byte groß (z. B. 30 GB); hinter den echten Daten steht Null.
/// Zählt, wie viel tatsächlich gelesen wurde.
pub struct Sparse {
    head: Vec<u8>,
    len: u64,
    pos: u64,
    pub read_bytes: Arc<AtomicUsize>,
}

impl Sparse {
    pub fn new(head: Vec<u8>, len: u64) -> (Sparse, Arc<AtomicUsize>) {
        let counter = Arc::new(AtomicUsize::new(0));
        (
            Sparse {
                head,
                len,
                pos: 0,
                read_bytes: counter.clone(),
            },
            counter,
        )
    }
}

impl Read for Sparse {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = (self.len.saturating_sub(self.pos)).min(buf.len() as u64) as usize;
        for (i, slot) in buf[..n].iter_mut().enumerate() {
            *slot = self
                .head
                .get((self.pos + i as u64) as usize)
                .copied()
                .unwrap_or(0);
        }
        self.pos += n as u64;
        self.read_bytes.fetch_add(n, Ordering::Relaxed);
        Ok(n)
    }
}

impl Seek for Sparse {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let next = match from {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::End(n) => self.len as i64 + n,
            SeekFrom::Current(n) => self.pos as i64 + n,
        };
        if next < 0 {
            return Err(io::Error::other("negative Position"));
        }
        self.pos = next as u64;
        Ok(self.pos)
    }
}

/* ------------------------------------------------------------------------------------- HTTP-Mock */

pub enum Reply {
    Body(&'static str, Vec<u8>),
    Status(u16),
    Redirect(String),
    /// Antwortet erst nach einer Wartezeit.
    Slow(Duration, Box<Reply>),
    /// Antwortet nie.
    Hang,
}

pub struct Mock {
    pub base: String,
    requests: Arc<Mutex<Vec<String>>>,
    /// Höchste Zahl gleichzeitig offener Anfragen.
    pub peak: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Mock {
    /// Angefragte Pfade (bereits prozent-dekodiert) in der Reihenfolge des Eintreffens.
    pub fn paths(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|raw| request_path(raw))
            .collect()
    }

    pub fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    /// Kopfzeilen der ersten Anfrage.
    pub fn first_request(&self) -> String {
        self.requests
            .lock()
            .unwrap()
            .first()
            .cloned()
            .unwrap_or_default()
    }
}

impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn request_path(raw: &str) -> String {
    let line = raw.lines().next().unwrap_or("");
    let target = line.split_whitespace().nth(1).unwrap_or("");
    super::matching::percent_decode(target)
}

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK",
        301 => "Moved Permanently",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Status",
    }
}

async fn respond(stream: &mut tokio::net::TcpStream, mut reply: Reply) {
    loop {
        match reply {
            Reply::Slow(wait, next) => {
                tokio::time::sleep(wait).await;
                reply = *next;
            }
            Reply::Hang => {
                tokio::time::sleep(Duration::from_secs(60)).await;
                return;
            }
            Reply::Body(kind, bytes) => {
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    bytes.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(&bytes).await;
                return;
            }
            Reply::Status(code) => {
                let head = format!(
                    "HTTP/1.1 {code} {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    status_text(code)
                );
                let _ = stream.write_all(head.as_bytes()).await;
                return;
            }
            Reply::Redirect(to) => {
                let head = format!(
                    "HTTP/1.1 301 Moved Permanently\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(head.as_bytes()).await;
                return;
            }
        }
    }
}

/// Startet den Server auf einem freien Port von 127.0.0.1. `handler` bekommt den dekodierten Pfad.
pub async fn serve<F>(handler: F) -> Mock
where
    F: Fn(&str) -> Reply + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requests: Arc<Mutex<Vec<String>>> = Arc::default();
    let peak = Arc::new(AtomicUsize::new(0));
    let inflight = Arc::new(AtomicUsize::new(0));
    let handler = Arc::new(handler);
    let (log, top, open) = (requests.clone(), peak.clone(), inflight);
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let (handler, log, top, open) =
                (handler.clone(), log.clone(), top.clone(), open.clone());
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 16 * 1024 {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let raw = String::from_utf8_lossy(&buf).into_owned();
                let path = request_path(&raw);
                log.lock().unwrap().push(raw);
                let now = open.fetch_add(1, Ordering::SeqCst) + 1;
                top.fetch_max(now, Ordering::SeqCst);
                respond(&mut stream, handler(&path)).await;
                open.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    Mock {
        base,
        requests,
        peak,
        task,
    }
}

/// HTML-Verzeichnisliste im Stil von nginx (`autoindex`), wie sie thumbnails.libretro.com liefert.
pub fn listing_html(files: &[&str]) -> Vec<u8> {
    let mut html = String::from("<html>\r\n<head><title>Index of /</title></head>\r\n<body>\r\n<h1>Index of /</h1><hr><pre><a href=\"../\">../</a>\r\n");
    for file in files {
        let href = super::matching::encode_segment(file);
        let shown = file.replace('&', "&amp;");
        html.push_str(&format!(
            "<a href=\"{href}\">{shown}</a>                      01-Jan-2024 00:00    52341\r\n"
        ));
    }
    html.push_str("</pre><hr></body>\r\n</html>\r\n");
    html.into_bytes()
}
