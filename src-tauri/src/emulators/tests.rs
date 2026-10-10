//! Tests der Emulator-Befehle: Fake-.app-Bundles (Info.plist als XML + Shell-Skript als Programmdatei) in einem
//! Temp-Ordner unter `target/`, Ereignisse über einen Kanal statt über Tauri.

use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::sync::atomic::{AtomicU64, Ordering};

/* ----------------------------------------------------------------------------------------- Aufbau */

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> TempDir {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!(
                "{tag}-{}-{}-{nanos}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
        fs::create_dir_all(&path).unwrap();
        TempDir(fs::canonicalize(path).unwrap())
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write_file(path: &Path, content: &str, mode: u32) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

const PLIST_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>EXE</string>
<key>CFBundleIdentifier</key><string>net.example.fake</string>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
<key>CFBundleName</key><string>Fake Emu</string>
</dict></plist>
"#;

/// Legt `<root>/<bundle>/Contents/{Info.plist,MacOS/<exe>}` an; die Programmdatei ist ein ausführbares Skript.
fn make_app(root: &Path, bundle: &str, exe: &str, script: &str) -> PathBuf {
    let app = root.join(bundle);
    write_file(
        &app.join("Contents/Info.plist"),
        &PLIST_XML.replace("EXE", exe),
        0o644,
    );
    write_file(&app.join("Contents/MacOS").join(exe), script, 0o755);
    app
}

/// Nur ein leeres Bundle-Verzeichnis (für die Suche).
fn make_empty_app(root: &Path, relative: &str) -> PathBuf {
    let app = root.join(relative);
    fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    app
}

fn channel_sink() -> (Arc<dyn ExitSink>, mpsc::Receiver<GameExit>) {
    let (sender, receiver) = mpsc::channel();
    let sender = Mutex::new(sender);
    let sink: Arc<dyn ExitSink> = Arc::new(move |event: GameExit| {
        let _ = lock(&sender).send(event);
    });
    (sink, receiver)
}

struct Env {
    dir: TempDir,
    home: PathBuf,
    procs: GameProcesses,
}

impl Env {
    fn new() -> Env {
        let dir = TempDir::new("emu");
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let procs = GameProcesses::with_kill_grace(
            dir.path().join("logs").join("launch.log"),
            Duration::from_millis(300),
        );
        Env { dir, home, procs }
    }

    /// Skript-App mit dem gegebenen Rumpf; `$OUT` ist ein Dateipfad-Präfix im Temp-Ordner.
    fn script_app(&self, name: &str, body: &str) -> PathBuf {
        let out = self.dir.path().join(format!("{name}.out"));
        let script = format!("#!/bin/sh\nOUT='{}'\n{body}\n", out.display());
        make_app(self.dir.path(), &format!("{name}.app"), name, &script)
    }

    fn out(&self, name: &str, suffix: &str) -> String {
        fs::read_to_string(self.dir.path().join(format!("{name}.out{suffix}"))).unwrap_or_default()
    }

    /// Startet; wiederholt bei "Text file busy" (frisch geschriebene Skripte in parallel laufenden Tests).
    fn launch(
        &self,
        id: &str,
        program: &Path,
        args: &[&str],
        label: Option<&str>,
    ) -> (Result<LaunchInfo, String>, mpsc::Receiver<GameExit>) {
        let (sink, receiver) = channel_sink();
        let request = LaunchRequest {
            id: id.to_string(),
            program: program.to_string_lossy().into_owned(),
            args: args.iter().map(|a| a.to_string()).collect(),
            label: label.map(str::to_string),
        };
        for attempt in 0..20 {
            let result = self.procs.launch(&request, &self.home, Arc::clone(&sink));
            if matches!(&result, Err(message) if message.contains("Text file busy")) && attempt < 19
            {
                thread::sleep(Duration::from_millis(50));
                continue;
            }
            return (result, receiver);
        }
        unreachable!()
    }

    fn launch_ok(
        &self,
        id: &str,
        program: &Path,
        args: &[&str],
    ) -> (LaunchInfo, mpsc::Receiver<GameExit>) {
        let (result, receiver) = self.launch(id, program, args, None);
        (
            result.unwrap_or_else(|err| panic!("Start fehlgeschlagen: {err}")),
            receiver,
        )
    }
}

fn exit_of(receiver: &mpsc::Receiver<GameExit>) -> GameExit {
    receiver
        .recv_timeout(Duration::from_secs(15))
        .expect("game-exit wurde nicht gemeldet")
}

/// Zustandsbuchstabe eines Prozesses (`None` = es gibt ihn nicht mehr). Linux liest /proc, macOS fragt `ps`.
fn process_state(pid: u32) -> Option<char> {
    #[cfg(target_os = "linux")]
    {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        stat.rsplit_once(')')?.1.trim_start().chars().next()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let output = run_with_timeout(
            "/bin/ps",
            &["-o", "stat=", "-p", &pid.to_string()],
            Duration::from_secs(5),
        )?;
        output.trim().chars().next()
    }
}

/// Zombies (beendet, aber noch nicht eingesammelt) zählen als tot.
fn process_alive(pid: u32) -> bool {
    process_state(pid).is_some_and(|state| state != 'Z')
}

fn process_group_of(pid: u32) -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        stat.rsplit_once(')')?
            .1
            .split_whitespace()
            .nth(2)?
            .parse()
            .ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let output = run_with_timeout(
            "/bin/ps",
            &["-o", "pgid=", "-p", &pid.to_string()],
            Duration::from_secs(5),
        )?;
        output.trim().parse().ok()
    }
}

fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "Zeitüberschreitung: {what}");
        thread::sleep(Duration::from_millis(20));
    }
}

/* ------------------------------------------------------------------------------- kleine Bausteine */

#[test]
fn timestamps_are_iso_8601_in_utc() {
    let at = |seconds: u64, millis: u32| {
        iso_timestamp(UNIX_EPOCH + Duration::new(seconds, millis * 1_000_000))
    };
    assert_eq!(at(0, 0), "1970-01-01T00:00:00.000Z");
    assert_eq!(at(1_700_000_000, 123), "2023-11-14T22:13:20.123Z");
    assert_eq!(at(951_782_400, 0), "2000-02-29T00:00:00.000Z"); // Schaltjahr
    assert_eq!(at(951_868_800, 999), "2000-03-01T00:00:00.999Z");
    assert_eq!(at(4_102_444_799, 0), "2099-12-31T23:59:59.000Z");
    assert_eq!(at(4_102_444_800, 0), "2100-01-01T00:00:00.000Z"); // 2100 ist kein Schaltjahr
    assert_eq!(at(1_709_164_800, 0), "2024-02-29T00:00:00.000Z");
    let now = iso_timestamp(SystemTime::now());
    assert_eq!(now.len(), 24, "{now}");
    assert!(now.starts_with("20") && now.ends_with('Z'));
}

#[test]
fn paths_are_expanded_and_trimmed() {
    let home = Path::new("/Users/test");
    assert_eq!(expand_path("~", home), PathBuf::from("/Users/test"));
    assert_eq!(
        expand_path("~/Applications/RPCS3.app", home),
        PathBuf::from("/Users/test/Applications/RPCS3.app")
    );
    assert_eq!(
        expand_path("  /Applications/RPCS3.app/  ", home),
        PathBuf::from("/Applications/RPCS3.app")
    );
    assert_eq!(expand_path("/", home), PathBuf::from("/"));
    assert_eq!(expand_path("///", home), PathBuf::from("/"));
    assert_eq!(
        expand_path("relativ/pfad", home),
        PathBuf::from("relativ/pfad")
    );
}

#[test]
fn display_quoting_protects_special_characters() {
    assert_eq!(quote_for_display("--no-gui"), "--no-gui");
    assert_eq!(quote_for_display("/a/b.iso"), "/a/b.iso");
    assert_eq!(quote_for_display("mit Leerzeichen"), "'mit Leerzeichen'");
    assert_eq!(quote_for_display("it's"), "'it'\\''s'");
    assert_eq!(quote_for_display(""), "''");
    assert_eq!(quote_for_display("Spiel (1).iso"), "'Spiel (1).iso'");
}

#[test]
fn output_lines_are_cleaned_and_shortened() {
    assert_eq!(clean_output_line(b"plain text"), "plain text");
    assert_eq!(
        clean_output_line(b"\x1b[31mrot\x1b[0m und \x1b[1;32mgr\xc3\xbcn\x1b[0m"),
        "rot und grün"
    );
    assert_eq!(clean_output_line(b"10%\r20%\r30%"), "30%");
    assert_eq!(clean_output_line(b"zeile\r"), "zeile");
    assert_eq!(clean_output_line(b"a\tb\x07c\x00d"), "a bcd");
    assert_eq!(clean_output_line(b"   "), "");
    assert_eq!(clean_output_line(b"ung\xffltig"), "ung\u{fffd}ltig");
    assert_eq!(clean_output_line(b"\x1b"), "");
    assert_eq!(clean_output_line(b"\x1b[31"), "");
    let long = "ä".repeat(1000);
    let short = clean_output_line(long.as_bytes());
    assert_eq!(short.chars().count(), 400);
    assert!(short.ends_with('…'));
    let exact = "x".repeat(400);
    assert_eq!(clean_output_line(exact.as_bytes()), exact);
}

#[test]
fn only_the_last_40_lines_per_stream_are_kept() {
    let tail = Mutex::new(VecDeque::new());
    let input: String = (1..=100).map(|n| format!("Zeile {n}\n")).collect();
    pump_lines(input.as_bytes(), &tail);
    let lines: Vec<String> = lock(&tail).iter().cloned().collect();
    assert_eq!(lines.len(), 40);
    assert_eq!(lines[0], "Zeile 61");
    assert_eq!(lines[39], "Zeile 100");

    // letzte Zeile ohne Zeilenumbruch, endlose Zeile ohne Umbruch, leere Zeilen
    let tail = Mutex::new(VecDeque::new());
    let mut input = b"\n\nerste\n".to_vec();
    input.extend(std::iter::repeat_n(b'x', 100_000));
    input.extend_from_slice(b"\nletzte ohne Umbruch");
    pump_lines(input.as_slice(), &tail);
    let lines: Vec<String> = lock(&tail).iter().cloned().collect();
    assert_eq!(lines.len(), 3, "{lines:?}");
    assert_eq!(lines[0], "erste");
    assert_eq!(lines[1].chars().count(), 400);
    assert_eq!(lines[2], "letzte ohne Umbruch");
}

/* ----------------------------------------------------------------------------- emulator_inspect */

#[test]
fn inspect_reads_a_bundle_through_info_plist() {
    let dir = TempDir::new("inspect");
    let app = make_app(dir.path(), "Fake Emu.app", "fake-exe", "#!/bin/sh\n");
    let found = inspect(&app.to_string_lossy(), Path::new("/nirgends"));
    assert_eq!(found.kind, "bundle");
    assert!(found.exists);
    assert_eq!(found.error, None);
    assert_eq!(
        found.executable.as_deref(),
        Some(app.join("Contents/MacOS/fake-exe").to_str().unwrap())
    );
    assert_eq!(found.name.as_deref(), Some("Fake Emu"));
    assert_eq!(found.bundle_id.as_deref(), Some("net.example.fake"));
    assert_eq!(found.version.as_deref(), Some("1.2.3"));

    // abschließender Schrägstrich und ~ funktionieren
    let with_slash = inspect(&format!("{}/", app.display()), Path::new("/nirgends"));
    assert_eq!(with_slash.executable, found.executable);
    assert_eq!(with_slash.path, found.path);
    let via_home = inspect("~/Fake Emu.app", dir.path());
    assert_eq!(via_home.executable, found.executable);
}

#[test]
fn inspect_reads_binary_plists_too() {
    let dir = TempDir::new("inspect-bin");
    let app = dir.path().join("Binaer.app");
    let mut dict = plist::Dictionary::new();
    dict.insert("CFBundleExecutable".into(), "binaer-exe".into());
    dict.insert("CFBundleIdentifier".into(), "net.example.binary".into());
    dict.insert("CFBundleVersion".into(), "77".into());
    dict.insert("CFBundleDisplayName".into(), "Binär Emu".into());
    fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    plist::Value::Dictionary(dict)
        .to_file_binary(app.join("Contents/Info.plist"))
        .unwrap();
    write_file(&app.join("Contents/MacOS/binaer-exe"), "#!/bin/sh\n", 0o755);
    let found = inspect(&app.to_string_lossy(), dir.path());
    assert_eq!(found.error, None);
    assert_eq!(found.name.as_deref(), Some("Binär Emu"));
    assert_eq!(found.bundle_id.as_deref(), Some("net.example.binary"));
    assert_eq!(
        found.version.as_deref(),
        Some("77"),
        "CFBundleVersion als Rückfall"
    );
    assert!(found
        .executable
        .unwrap()
        .ends_with("Contents/MacOS/binaer-exe"));
}

#[test]
fn inspect_falls_back_to_the_only_executable() {
    let dir = TempDir::new("inspect-fallback");
    // keine Info.plist
    let app = dir.path().join("OhnePlist.app");
    write_file(&app.join("Contents/MacOS/programm"), "#!/bin/sh\n", 0o755);
    write_file(
        &app.join("Contents/MacOS/readme.txt"),
        "kein Programm",
        0o644,
    );
    let found = inspect(&app.to_string_lossy(), dir.path());
    assert_eq!(found.error, None);
    assert!(found
        .executable
        .as_deref()
        .is_some_and(|p| p.ends_with("Contents/MacOS/programm")));
    assert_eq!(
        found.name.as_deref(),
        Some("OhnePlist"),
        "Name aus dem Dateinamen"
    );
    assert_eq!(found.bundle_id, None);

    // CFBundleExecutable nennt eine fehlende Datei, es gibt genau eine ausführbare
    let app = dir.path().join("Falsch.app");
    write_file(
        &app.join("Contents/Info.plist"),
        &PLIST_XML.replace("EXE", "gibt-es-nicht"),
        0o644,
    );
    write_file(&app.join("Contents/MacOS/echt"), "#!/bin/sh\n", 0o755);
    let found = inspect(&app.to_string_lossy(), dir.path());
    assert!(
        found
            .executable
            .as_deref()
            .is_some_and(|p| p.ends_with("Contents/MacOS/echt")),
        "{found:?}"
    );
    assert_eq!(found.bundle_id.as_deref(), Some("net.example.fake"));

    // Pfadbestandteile in CFBundleExecutable werden nicht ernst genommen
    let app = dir.path().join("Gefaehrlich.app");
    write_file(
        &app.join("Contents/Info.plist"),
        &PLIST_XML.replace("EXE", "../../../outside"),
        0o644,
    );
    write_file(&app.join("Contents/MacOS/drin"), "#!/bin/sh\n", 0o755);
    write_file(&dir.path().join("outside"), "#!/bin/sh\n", 0o755);
    let found = inspect(&app.to_string_lossy(), dir.path());
    assert!(
        found
            .executable
            .as_deref()
            .is_some_and(|p| p.ends_with("Contents/MacOS/drin")),
        "{found:?}"
    );
}

#[test]
fn inspect_explains_broken_bundles() {
    let dir = TempDir::new("inspect-broken");

    let empty = make_empty_app(dir.path(), "Leer.app");
    let found = inspect(&empty.to_string_lossy(), dir.path());
    assert!(found.exists && found.kind == "bundle" && found.executable.is_none());
    assert!(
        found
            .error
            .as_deref()
            .unwrap()
            .starts_with("Keine ausführbare Datei in "),
        "{found:?}"
    );

    let two = dir.path().join("Zwei.app");
    write_file(&two.join("Contents/MacOS/a"), "#!/bin/sh\n", 0o755);
    write_file(&two.join("Contents/MacOS/b"), "#!/bin/sh\n", 0o755);
    let found = inspect(&two.to_string_lossy(), dir.path());
    assert!(
        found.executable.is_none()
            && found
                .error
                .as_deref()
                .unwrap()
                .contains("Mehrere ausführbare"),
        "{found:?}"
    );

    let no_bit = dir.path().join("OhneBit.app");
    write_file(
        &no_bit.join("Contents/Info.plist"),
        &PLIST_XML.replace("EXE", "prog"),
        0o644,
    );
    write_file(&no_bit.join("Contents/MacOS/prog"), "#!/bin/sh\n", 0o644);
    let found = inspect(&no_bit.to_string_lossy(), dir.path());
    assert!(found.executable.is_none());
    assert!(
        found.error.as_deref().unwrap().contains("nicht ausführbar"),
        "{found:?}"
    );

    let not_a_bundle = dir.path().join("Ordner");
    fs::create_dir_all(&not_a_bundle).unwrap();
    let found = inspect(&not_a_bundle.to_string_lossy(), dir.path());
    assert!(found.exists && found.kind == "other" && found.executable.is_none());
    assert!(
        found.error.as_deref().unwrap().contains("Ordner"),
        "{found:?}"
    );

    let missing = inspect("/gibt/es/nicht.app", dir.path());
    assert!(!missing.exists && missing.kind == "other" && missing.executable.is_none());
    assert!(
        missing
            .error
            .as_deref()
            .unwrap()
            .starts_with("Pfad nicht gefunden: /gibt/es/nicht.app"),
        "{missing:?}"
    );

    // kaputte Info.plist, aber eindeutige Programmdatei → trotzdem brauchbar
    let broken = dir.path().join("KaputtePlist.app");
    write_file(
        &broken.join("Contents/Info.plist"),
        "das ist kein plist",
        0o644,
    );
    write_file(&broken.join("Contents/MacOS/prog"), "#!/bin/sh\n", 0o755);
    let found = inspect(&broken.to_string_lossy(), dir.path());
    assert!(
        found.executable.is_some() && found.error.is_none(),
        "{found:?}"
    );
}

#[test]
fn inspect_checks_plain_files() {
    let dir = TempDir::new("inspect-file");
    let runnable = dir.path().join("emulator");
    write_file(&runnable, "#!/bin/sh\n", 0o755);
    let found = inspect(&runnable.to_string_lossy(), dir.path());
    assert_eq!((found.kind, found.exists), ("file", true));
    assert_eq!(found.executable.as_deref(), runnable.to_str());
    assert_eq!(found.name.as_deref(), Some("emulator"));
    assert_eq!(found.error, None);

    let plain = dir.path().join("notiz.txt");
    write_file(&plain, "Text", 0o644);
    let found = inspect(&plain.to_string_lossy(), dir.path());
    assert_eq!(found.kind, "file");
    assert_eq!(found.executable, None);
    assert!(
        found.error.as_deref().unwrap().contains("nicht ausführbar"),
        "{found:?}"
    );
}

#[test]
fn inspect_serializes_with_the_documented_field_names() {
    let found = inspect("/gibt/es/nicht", Path::new("/"));
    let json = serde_json::to_value(&found).unwrap();
    let mut keys: Vec<&str> = json
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "bundleId",
            "error",
            "executable",
            "exists",
            "kind",
            "name",
            "path",
            "version"
        ]
    );
    assert_eq!(json["exists"], false);
    assert!(json["executable"].is_null() && json["bundleId"].is_null());
}

/* ------------------------------------------------------------------------------------- Starten */

#[test]
fn launch_runs_the_program_and_reports_the_exit() {
    let env = Env::new();
    let app = env.script_app(
        "spiel",
        r#"printf '%s\n' "$@" > "$OUT.args"
pwd > "$OUT.cwd"
cat > "$OUT.stdin"
echo "hello stdout"
echo "ERST stderr" >&2
echo "kaputt: Firmware fehlt" >&2
sleep 0.3
exit 7"#,
    );
    let args = [
        "--no-gui",
        "/pfad/mit Leerzeichen/Spiel (1).iso",
        "it's \"quoted\" ü",
    ];
    let (info, receiver) = env.launch_ok("ps3:spiel", &app, &args);
    assert_eq!(info.id, "ps3:spiel");
    assert!(info.pid > 1);
    assert_eq!(
        info.executable,
        app.join("Contents/MacOS/spiel").to_string_lossy()
    );
    assert_eq!(
        info.command_line,
        format!(
            "{} --no-gui '/pfad/mit Leerzeichen/Spiel (1).iso' 'it'\\''s \"quoted\" ü'",
            info.executable
        )
    );
    assert!(env.procs.is_running("ps3:spiel"));
    assert_eq!(env.procs.running(), ["ps3:spiel"]);

    let exit = exit_of(&receiver);
    assert_eq!(exit.id, "ps3:spiel");
    assert_eq!(exit.code, Some(7));
    assert_eq!(exit.signal, None);
    assert!(
        exit.duration_ms >= 250 && exit.duration_ms < 8000,
        "{}",
        exit.duration_ms
    );
    assert_eq!(exit.stdout_tail, ["hello stdout"]);
    assert_eq!(exit.stderr_tail, ["ERST stderr", "kaputt: Firmware fehlt"]);
    // vor der Meldung ausgetragen: wer das Ereignis bekommt, darf sofort neu starten
    assert!(env.procs.running().is_empty());

    // Argumente kommen unverändert an, Arbeitsverzeichnis = Home, stdin ist geschlossen
    assert_eq!(env.out("spiel", ".args"), format!("{}\n", args.join("\n")));
    assert_eq!(
        fs::canonicalize(env.out("spiel", ".cwd").trim()).unwrap(),
        fs::canonicalize(&env.home).unwrap()
    );
    assert_eq!(env.out("spiel", ".stdin"), "");

    // Protokoll: Start (mit Befehlszeile) und Ende (mit Code und Dauer), danach die Ausgabe wegen des Fehlercodes
    let log = env.procs.log().tail(50);
    assert!(
        log.iter()
            .any(|l| l.contains("START id=ps3:spiel") && l.contains(&info.command_line)),
        "{log:?}"
    );
    assert!(
        log.iter()
            .any(|l| l.contains("ENDE id=ps3:spiel code=7 dauer=")),
        "{log:?}"
    );
    assert!(
        log.iter()
            .any(|l| l.contains("STDERR id=ps3:spiel | kaputt: Firmware fehlt")),
        "{log:?}"
    );
    for line in &log {
        assert!(
            line.len() > 25 && line.as_bytes()[4] == b'-' && line.as_bytes()[10] == b'T',
            "ISO-Zeitstempel erwartet: {line}"
        );
    }
    // und erneut starten ist jetzt möglich
    let (again, receiver) = env.launch_ok("ps3:spiel", &app, &[]);
    assert_ne!(again.pid, info.pid);
    assert_eq!(exit_of(&receiver).code, Some(7));
}

#[test]
fn exit_event_serializes_with_the_documented_field_names() {
    let event = GameExit {
        id: "x".into(),
        code: Some(0),
        signal: None,
        duration_ms: 12,
        stderr_tail: vec!["a".into()],
        stdout_tail: vec![],
        hint: None,
    };
    let json = serde_json::to_value(&event).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "id": "x", "code": 0, "signal": null, "durationMs": 12, "stderrTail": ["a"], "stdoutTail": [], "hint": null })
    );
    let info = LaunchInfo {
        id: "x".into(),
        pid: 5,
        executable: "/e".into(),
        command_line: "/e a".into(),
    };
    assert_eq!(
        serde_json::to_value(&info).unwrap(),
        serde_json::json!({ "id": "x", "pid": 5, "executable": "/e", "commandLine": "/e a" })
    );
}

#[test]
fn a_program_that_dies_by_signal_reports_the_signal() {
    let env = Env::new();
    let app = env.script_app(
        "absturz",
        "echo 'Segmentation fault (simuliert)' >&2\nkill -SEGV $$\nsleep 5",
    );
    let (_, receiver) = env.launch_ok("absturz", &app, &[]);
    let exit = exit_of(&receiver);
    assert_eq!(exit.code, None);
    assert_eq!(exit.signal.as_deref(), Some("SIGSEGV"));
    assert_eq!(exit.stderr_tail, ["Segmentation fault (simuliert)"]);
    assert!(
        exit.hint
            .as_deref()
            .is_some_and(|hint| hint.contains("abgestürzt (SIGSEGV)")),
        "{:?}",
        exit.hint
    );
    let log = env.procs.log().tail(20);
    assert!(
        log.iter()
            .any(|l| l.contains("ENDE id=absturz signal=SIGSEGV")),
        "{log:?}"
    );
    assert!(
        log.iter()
            .any(|l| l.contains("HINWEIS id=absturz Das Programm ist abgestürzt (SIGSEGV)")),
        "{log:?}"
    );
}

#[test]
fn starting_the_same_id_twice_is_refused() {
    let env = Env::new();
    let app = env.script_app("lang", "sleep 5");
    let other = env.script_app("andere", "sleep 5");
    let (first, receiver) = env.launch_ok("spiel-1", &app, &[]);

    let (second, _) = env.launch("spiel-1", &app, &[], Some("Gran Turismo 5"));
    let message = second.unwrap_err();
    assert_eq!(message, "„Gran Turismo 5“ läuft bereits");
    let (second, _) = env.launch("spiel-1", &other, &[], None);
    assert_eq!(second.unwrap_err(), "„spiel-1“ läuft bereits");
    assert_eq!(
        env.procs.running(),
        ["spiel-1"],
        "der erste Start bleibt unberührt"
    );
    assert!(process_alive(first.pid));

    // eine andere ID startet parallel
    let (third, receiver_third) = env.launch_ok("spiel-2", &other, &[]);
    assert_eq!(env.procs.running(), ["spiel-1", "spiel-2"]);
    assert!(env.procs.kill("spiel-1") && env.procs.kill("spiel-2"));
    assert_eq!(exit_of(&receiver).signal.as_deref(), Some("SIGTERM"));
    assert_eq!(exit_of(&receiver_third).id, "spiel-2");
    assert_ne!(first.pid, third.pid);
    // Fehler stehen im Protokoll
    assert!(env
        .procs
        .log()
        .tail(100)
        .iter()
        .any(|l| l.contains("FEHLER id=spiel-1 „Gran Turismo 5“ läuft bereits")));
}

#[test]
fn kill_sends_sigterm_and_unknown_ids_return_false() {
    let env = Env::new();
    let app = env.script_app("dauerlauf", "sleep 30");
    let (info, receiver) = env.launch_ok("dauer", &app, &[]);
    assert!(!env.procs.kill("gibt-es-nicht"));
    let started = Instant::now();
    assert!(env.procs.kill("dauer"));
    let exit = exit_of(&receiver);
    assert_eq!(exit.signal.as_deref(), Some("SIGTERM"));
    assert_eq!(exit.code, None);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert!(!process_alive(info.pid));
    assert!(!env.procs.kill("dauer"), "nach dem Ende läuft nichts mehr");
    assert!(env
        .procs
        .log()
        .tail(20)
        .iter()
        .any(|l| l.contains("BEENDEN id=dauer")));
}

#[test]
fn kill_escalates_to_sigkill_when_sigterm_is_ignored() {
    let env = Env::new();
    let app = env.script_app(
        "stur",
        "trap '' TERM\necho ready > \"$OUT.ready\"\nwhile :; do sleep 0.1; done",
    );
    let (_, receiver) = env.launch_ok("stur", &app, &[]);
    eventually("Skript hat die TERM-Falle gesetzt", || {
        env.out("stur", ".ready").contains("ready")
    });
    let started = Instant::now();
    assert!(env.procs.kill("stur"));
    let exit = exit_of(&receiver);
    assert_eq!(exit.signal.as_deref(), Some("SIGKILL"), "{exit:?}");
    assert!(
        started.elapsed() >= Duration::from_millis(250),
        "Gnadenfrist wurde nicht abgewartet: {:?}",
        started.elapsed()
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(env
        .procs
        .log()
        .tail(50)
        .iter()
        .any(|l| l.contains("SIGKILL nach 300 ms")));
}

#[test]
fn kill_reaches_helper_processes_in_the_group() {
    let env = Env::new();
    let app = env.script_app("mitkind", "sleep 60 &\necho $! > \"$OUT.child\"\nwait");
    let (info, receiver) = env.launch_ok("mitkind", &app, &[]);
    eventually("Hilfsprozess gestartet", || {
        env.out("mitkind", ".child").trim().parse::<u32>().is_ok()
    });
    let child: u32 = env.out("mitkind", ".child").trim().parse().unwrap();
    assert!(process_alive(child));

    // Eigene Prozessgruppe: Gruppen-ID = Prozess-ID des Spiels, nicht die des Testprozesses
    let group_id = process_group_of(info.pid).expect("Prozessgruppe lesbar");
    assert_eq!(group_id, info.pid);
    assert_ne!(group_id, std::process::id());

    assert!(env.procs.kill("mitkind"));
    exit_of(&receiver);
    eventually("Hilfsprozess ist mit beendet", || !process_alive(child));
}

#[test]
fn heavy_output_does_not_block_the_program() {
    let env = Env::new();
    // 3 MB nach stderr und 3 MB nach stdout (ohne Zeilenumbruch am Ende), dann Ende
    let app = env.script_app(
        "geschwaetzig",
        r#"pad=$(printf '%090d' 0)
i=0
while [ $i -lt 30000 ]; do
  echo "stderr Zeile $i $pad" >&2
  echo "stdout Zeile $i"
  i=$((i+1))
done
printf 'ohne Umbruch'"#,
    );
    let (_, receiver) = env.launch_ok("viel", &app, &[]);
    let exit = exit_of(&receiver);
    assert_eq!(exit.code, Some(0));
    assert_eq!(exit.stderr_tail.len(), 40);
    assert!(
        exit.stderr_tail[39].starts_with("stderr Zeile 29999 "),
        "{:?}",
        exit.stderr_tail.last()
    );
    assert_eq!(exit.stdout_tail.len(), 40);
    assert_eq!(exit.stdout_tail[39], "ohne Umbruch");
    assert_eq!(exit.stdout_tail[38], "stdout Zeile 29999");
    // normales Ende → keine Ausgabe im Protokoll
    assert!(!env
        .procs
        .log()
        .tail(50)
        .iter()
        .any(|l| l.contains("STDERR")));
}

#[test]
fn launch_errors_are_german_and_concrete() {
    let env = Env::new();
    let missing = env.dir.path().join("Fehlt.app");
    let (result, _) = env.launch("a", &missing, &[], None);
    assert_eq!(
        result.unwrap_err(),
        format!("Programm nicht gefunden: {}", missing.display())
    );

    let empty = make_empty_app(env.dir.path(), "Leer.app");
    let (result, _) = env.launch("b", &empty, &[], None);
    assert_eq!(
        result.unwrap_err(),
        format!(
            "Keine ausführbare Datei in {}",
            empty.join("Contents/MacOS").display()
        )
    );

    let no_bit = env.dir.path().join("kein-bit");
    write_file(&no_bit, "#!/bin/sh\n", 0o644);
    let (result, _) = env.launch("c", &no_bit, &[], None);
    assert!(result
        .unwrap_err()
        .starts_with("Keine ausführbare Datei (Ausführungsrecht fehlt):"));

    let folder = env.dir.path().join("einfach-ein-ordner");
    fs::create_dir_all(&folder).unwrap();
    let (result, _) = env.launch("d", &folder, &[], None);
    assert!(result.unwrap_err().contains("Ordner und kein Programm"));

    let (result, _) = env.launch("  ", &no_bit, &[], None);
    assert_eq!(result.unwrap_err(), "Keine Spiel-ID angegeben");
    let (result, _) = env.launch("e", Path::new(""), &[], None);
    assert_eq!(result.unwrap_err(), "Kein Programm angegeben");

    // Interpreter fehlt: der Betriebssystem-Fehler wird durchgereicht, die ID bleibt nicht hängen
    let bad = env.dir.path().join("kaputter-interpreter");
    write_file(&bad, "#!/gibt/es/nicht/interpreter\n", 0o755);
    let (result, _) = env.launch("f", &bad, &[], None);
    let message = result.unwrap_err();
    assert!(message.starts_with("Start nicht möglich: "), "{message}");
    assert!(message.contains("os error 2"), "{message}");
    assert!(env.procs.running().is_empty());

    // ... und alles steht im Protokoll
    let log = env.procs.log().tail(50);
    for expected in [
        "FEHLER id=a Programm nicht gefunden",
        "FEHLER id=b Keine ausführbare Datei in",
        "FEHLER id=f Start nicht möglich",
    ] {
        assert!(
            log.iter().any(|l| l.contains(expected)),
            "{expected} fehlt in {log:?}"
        );
    }
}

#[test]
fn bare_executables_start_like_bundles() {
    let env = Env::new();
    let script = env.dir.path().join("emulator.sh");
    write_file(&script, "#!/bin/sh\necho \"args: $#\"\nexit 3\n", 0o755);
    let (info, receiver) = env.launch_ok("datei", &script, &["a", "b"]);
    assert_eq!(info.executable, script.to_string_lossy());
    let exit = exit_of(&receiver);
    assert_eq!(
        (exit.code, exit.stdout_tail),
        (Some(3), vec!["args: 2".to_string()])
    );
}

/* ------------------------------------------------------------------------------------ Protokoll */

#[test]
fn the_log_is_limited_to_about_256_kib() {
    let dir = TempDir::new("log");
    let log = LaunchLog::new(dir.path().join("nested/ordner/launch.log"));
    for index in 0..3000 {
        log.append(&format!("EREIGNIS {index} {}", "x".repeat(200)));
    }
    let size = fs::metadata(log.path()).unwrap().len();
    assert!(size <= 256 * 1024, "{size} Bytes");
    assert!(
        size > 100 * 1024,
        "es soll nicht übermäßig gekürzt werden: {size} Bytes"
    );
    let lines = log.tail(5000);
    assert!(lines.len() <= 1000);
    assert!(lines.last().unwrap().contains("EREIGNIS 2999 "));
    let all = fs::read_to_string(log.path()).unwrap();
    for line in all.lines() {
        assert!(
            line.as_bytes()[4] == b'-' && line.contains(" EREIGNIS "),
            "Zeile nicht vollständig: {line:.60}"
        );
    }
    assert!(all.lines().count() < 2000 && all.lines().count() > 500);
}

#[test]
fn log_tail_returns_the_last_lines() {
    let dir = TempDir::new("log-tail");
    let log = LaunchLog::new(dir.path().join("launch.log"));
    assert!(log.tail(10).is_empty(), "fehlende Datei = leer");
    for index in 1..=30 {
        log.append(&format!("Zeile {index}"));
    }
    let last = log.tail(3);
    assert_eq!(last.len(), 3);
    assert!(
        last[0].ends_with("Zeile 28") && last[2].ends_with("Zeile 30"),
        "{last:?}"
    );
    assert_eq!(log.tail(0), Vec::<String>::new());
    assert_eq!(log.tail(1000).len(), 30);
    assert_eq!(log.tail(usize::MAX).len(), 30);
}

#[test]
fn log_lines_stay_single_lines() {
    let dir = TempDir::new("log-lines");
    let log = LaunchLog::new(dir.path().join("launch.log"));
    log.append("eins\nzwei\r\ndrei\u{1b}[31m");
    log.append(&"y".repeat(5000));
    let lines = log.tail(10);
    assert_eq!(lines.len(), 2);
    assert!(lines[0].ends_with("eins zwei  drei [31m"), "{:?}", lines[0]);
    assert!(
        lines[1].len() < 1100,
        "Zeilen werden gekürzt: {}",
        lines[1].len()
    );
}

#[test]
fn concurrent_log_writes_do_not_interleave() {
    let dir = TempDir::new("log-threads");
    let log = Arc::new(LaunchLog::new(dir.path().join("launch.log")));
    let workers: Vec<_> = (0..8)
        .map(|worker| {
            let log = Arc::clone(&log);
            thread::spawn(move || {
                for index in 0..100 {
                    log.append(&format!("W{worker} Nr {index} {}", "z".repeat(50)));
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    let lines = fs::read_to_string(log.path()).unwrap();
    assert_eq!(lines.lines().count(), 800);
    for line in lines.lines() {
        assert!(
            line.ends_with(&"z".repeat(50)) && line.contains(" W"),
            "{line}"
        );
    }
}

/* ---------------------------------------------------------------------------------- emulator_find */

fn spec(id: &str, pattern: &str, bundle_ids: &[&str]) -> EmulatorSpec {
    EmulatorSpec {
        id: id.to_string(),
        app_pattern: pattern.to_string(),
        bundle_ids: bundle_ids.iter().map(|b| b.to_string()).collect(),
    }
}

fn hit_list(hits: &EmulatorHits) -> Vec<(String, &'static str)> {
    hits.matches
        .iter()
        .map(|m| (m.path.clone(), m.source))
        .collect()
}

struct Roots {
    dir: TempDir,
    roots: SearchRoots,
}

fn fake_roots() -> Roots {
    let dir = TempDir::new("find");
    let root = dir.path().to_path_buf();
    let roots = SearchRoots {
        applications: vec![root.join("Applications")],
        user_applications: vec![root.join("home/Applications")],
        downloads: vec![root.join("home/Downloads")],
        desktop: vec![root.join("home/Desktop")],
    };
    for folder in roots
        .applications
        .iter()
        .chain(&roots.user_applications)
        .chain(&roots.downloads)
        .chain(&roots.desktop)
    {
        fs::create_dir_all(folder).unwrap();
    }
    Roots { dir, roots }
}

#[test]
fn find_orders_matches_by_source_and_ignores_case() {
    let fake = fake_roots();
    let root = fake.dir.path();
    let (apps, user, downloads, desktop) = (
        &fake.roots.applications[0],
        &fake.roots.user_applications[0],
        &fake.roots.downloads[0],
        &fake.roots.desktop[0],
    );
    make_empty_app(apps, "RPCS3.app");
    make_empty_app(apps, "Safari.app");
    make_empty_app(user, "rpcs3-nightly.APP"); // andere Schreibweise von Name und Endung
    make_empty_app(apps, "Emulatoren/RPCS3 Alt.app"); // direkter Unterordner
    make_empty_app(user, "Spiele/RPCS3.app");
    make_empty_app(downloads, "RPCS3-Mac/RPCS3.app");
    make_empty_app(downloads, "DuckStation.app");
    make_empty_app(desktop, "RPCS3.app");
    let spotlight_hit = make_empty_app(&root.join("Volumes/Extern"), "RPCS3 Beta.app");

    let spotlight_calls = Mutex::new(Vec::<String>::new());
    let spotlight = |bundle_id: &str| {
        lock(&spotlight_calls).push(bundle_id.to_string());
        if bundle_id == "net.rpcs3.rpcs3" {
            vec![spotlight_hit.clone()]
        } else {
            Vec::new()
        }
    };
    let found = find_emulators(
        &fake.roots,
        Some(&spotlight),
        &[
            spec(
                "rpcs3",
                r"^RPCS3.*\.app$",
                &["net.rpcs3.rpcs3", "net.rpcs3.other"],
            ),
            spec("duck", r"^DuckStation.*\.app$", &[]),
            spec("nichts", r"^Gibts nicht\.app$", &[]),
        ],
    );
    assert_eq!(
        found.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(),
        ["rpcs3", "duck", "nichts"]
    );

    let p = |base: &Path, rest: &str| base.join(rest).to_string_lossy().into_owned();
    assert_eq!(
        hit_list(&found[0]),
        vec![
            (p(apps, "RPCS3.app"), "applications"),
            (p(user, "rpcs3-nightly.APP"), "user-applications"),
            (p(apps, "Emulatoren/RPCS3 Alt.app"), "subfolder"),
            (p(user, "Spiele/RPCS3.app"), "subfolder"),
            (spotlight_hit.to_string_lossy().into_owned(), "spotlight"),
            (p(downloads, "RPCS3-Mac/RPCS3.app"), "downloads"),
            (p(desktop, "RPCS3.app"), "desktop"),
        ]
    );
    assert_eq!(
        hit_list(&found[1]),
        vec![(p(downloads, "DuckStation.app"), "downloads")]
    );
    assert!(found[2].matches.is_empty());
    // Spotlight wird nur für die Bundle-Identifier des jeweiligen Emulators befragt
    assert_eq!(
        *lock(&spotlight_calls),
        ["net.rpcs3.rpcs3", "net.rpcs3.other"]
    );
}

#[test]
fn find_skips_trash_duplicates_files_and_bundle_internals() {
    let fake = fake_roots();
    let root = fake.dir.path();
    let apps = &fake.roots.applications[0];
    let real = make_empty_app(apps, "RPCS3.app");
    make_empty_app(&root.join("home/.Trash"), "RPCS3.app");
    make_empty_app(&root.join("home/Downloads/.Trash"), "RPCS3 alt.app");
    make_empty_app(&root.join("home/Downloads/Trash"), "RPCS3 alt2.app");
    make_empty_app(
        &root.join("home/Downloads/.versteckt"),
        "RPCS3 versteckt.app",
    );
    make_empty_app(apps, "Foo.app/Contents/Plugins/RPCS3.app"); // innerhalb eines Bundles
    fs::write(apps.join("RPCS3 Datei.app"), "kein Verzeichnis").unwrap(); // Datei statt Bundle
    fs::create_dir_all(apps.join("RPCS3 Ordner")).unwrap(); // Verzeichnis ohne .app
    symlink(&real, apps.join("RPCS3 Link.app")).unwrap(); // Symlink auf dasselbe Bundle → Duplikat
    symlink(root.join("gibt/es/nicht"), apps.join("RPCS3 Kaputt.app")).unwrap(); // toter Symlink

    let trash_in_spotlight = make_empty_app(&root.join("home/.Trash"), "RPCS3 Papierkorb.app");
    let alias_of_real = root.join("Applications/../Applications/RPCS3.app");
    let not_an_app = apps.join("RPCS3 Ordner");
    let missing = root.join("weg/RPCS3.app");
    let spotlight = move |_: &str| {
        vec![
            trash_in_spotlight.clone(),
            alias_of_real.clone(),
            not_an_app.clone(),
            missing.clone(),
            real.clone(),
        ]
    };
    let found = find_emulators(
        &fake.roots,
        Some(&spotlight),
        &[spec("rpcs3", r"^RPCS3.*\.app$", &["net.rpcs3.rpcs3"])],
    );
    assert_eq!(
        hit_list(&found[0]),
        vec![(
            apps.join("RPCS3.app").to_string_lossy().into_owned(),
            "applications"
        )],
        "genau ein Treffer: kein Papierkorb, keine Duplikate, keine Dateien"
    );
}

#[test]
fn find_survives_bad_patterns_missing_folders_and_nothing_to_search() {
    let fake = fake_roots();
    make_empty_app(&fake.roots.applications[0], "RPCS3.app");
    let found = find_emulators(
        &fake.roots,
        None,
        &[
            spec("kaputt", "([unvollständig", &[]),
            spec("leer", "", &[]),
            spec("riesig", "((a{100}){100}){100}", &[]),
            spec("gut", "rpcs3", &[]),
        ],
    );
    assert!(
        found[0].matches.is_empty() && found[1].matches.is_empty() && found[2].matches.is_empty()
    );
    assert_eq!(
        found[3].matches.len(),
        1,
        "unvollständige Muster stören die anderen nicht"
    );
    // Der Fehler wird gemeldet (statt still keine Treffer zu liefern); gute und leere Muster haben keinen
    assert!(
        found[0]
            .error
            .as_deref()
            .is_some_and(|e| e.starts_with("Ungültiges Suchmuster (appPattern): ")),
        "{:?}",
        found[0].error
    );
    assert_eq!(found[1].error, None);
    assert_eq!(
        found[2].error.as_deref(),
        Some("Das Suchmuster (appPattern) ist zu umfangreich")
    );
    assert_eq!(found[3].error, None);
    let json = serde_json::to_value(&found[3]).unwrap();
    assert!(
        json.as_object().unwrap().get("error").is_none(),
        "ohne Fehler bleibt die Antwort genau {{id, matches}}"
    );
    assert!(serde_json::to_value(&found[0])
        .unwrap()
        .get("error")
        .is_some());

    let nowhere = SearchRoots {
        applications: vec![PathBuf::from("/gibt/es/nicht")],
        user_applications: vec![],
        downloads: vec![PathBuf::from("")],
        desktop: vec![],
    };
    let found = find_emulators(&nowhere, None, &[spec("x", ".*", &["a.b"])]);
    assert_eq!(found.len(), 1);
    assert!(found[0].matches.is_empty());
    assert!(find_emulators(&nowhere, None, &[]).is_empty());
}

#[test]
fn find_without_spotlight_ignores_bundle_ids() {
    let fake = fake_roots();
    let found = find_emulators(
        &fake.roots,
        None,
        &[spec("x", "^nichts$", &["net.rpcs3.rpcs3"])],
    );
    assert!(found[0].matches.is_empty());
}

#[test]
fn search_roots_point_to_the_documented_places() {
    let roots = SearchRoots::system(Path::new("/Users/test"));
    assert_eq!(roots.applications, [PathBuf::from("/Applications")]);
    assert_eq!(
        roots.user_applications,
        [PathBuf::from("/Users/test/Applications")]
    );
    assert_eq!(roots.downloads, [PathBuf::from("/Users/test/Downloads")]);
    assert_eq!(roots.desktop, [PathBuf::from("/Users/test/Desktop")]);
}

#[test]
fn specs_deserialize_from_the_frontend_shape() {
    let specs: Vec<EmulatorSpec> = serde_json::from_str(
        r#"[{"id":"rpcs3","appPattern":"^RPCS3.*\\.app$","bundleIds":["net.rpcs3.rpcs3"]},{"id":"x","appPattern":"y"}]"#,
    )
    .unwrap();
    assert_eq!(specs[0].app_pattern, "^RPCS3.*\\.app$");
    assert_eq!(specs[0].bundle_ids, ["net.rpcs3.rpcs3"]);
    assert!(specs[1].bundle_ids.is_empty());
    let hits = EmulatorHits {
        id: "rpcs3".into(),
        matches: vec![EmulatorMatch {
            path: "/Applications/RPCS3.app".into(),
            source: "applications",
        }],
        error: None,
    };
    assert_eq!(
        serde_json::to_value(&hits).unwrap(),
        serde_json::json!({ "id": "rpcs3", "matches": [{ "path": "/Applications/RPCS3.app", "source": "applications" }] })
    );
}

/* -------------------------------------------------------------------------------------- Spotlight */

#[test]
fn processes_run_without_a_shell_and_with_a_time_limit() {
    assert_eq!(
        run_with_timeout(
            "/bin/echo",
            &["a  b", "$HOME", "`x`;y"],
            Duration::from_secs(5)
        )
        .as_deref(),
        Some("a  b $HOME `x`;y\n")
    );
    let started = Instant::now();
    assert_eq!(
        run_with_timeout("/bin/sleep", &["30"], Duration::from_millis(300)),
        None
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(
        run_with_timeout("/gibt/es/nicht", &[], Duration::from_secs(1)),
        None
    );
}

#[test]
fn spotlight_refuses_dangerous_identifiers() {
    let too_long = "x".repeat(300);
    for bad in [
        "",
        "a b",
        "a'b",
        "a' || kMDItemKind == '",
        "a\"b",
        "a;b",
        "a\nb",
        too_long.as_str(),
    ] {
        assert!(
            spotlight_bundle(bad, Duration::from_secs(1)).is_empty(),
            "{bad:?}"
        );
    }
    assert!(spotlight_bundle("net.rpcs3.rpcs3", Duration::ZERO).is_empty());
    // Auf Linux gibt es kein mdfind: leere Liste statt Fehler
    #[cfg(not(target_os = "macos"))]
    assert!(spotlight_bundle("net.rpcs3.rpcs3", Duration::from_secs(1)).is_empty());
}

#[test]
fn exit_hints_are_given_only_where_the_signal_says_something() {
    let hint =
        |signal: Option<&str>, ms: u64, ours: bool, macos: bool| exit_hint(signal, ms, ours, macos);
    // kein Signal, harmlose Signale, gewolltes Ende
    assert_eq!(hint(None, 100, false, true), None);
    assert_eq!(hint(Some("SIGTERM"), 100, false, true), None);
    assert_eq!(hint(Some("SIGHUP"), 100, false, true), None);
    assert_eq!(hint(Some("SIGPIPE"), 100, false, true), None);
    assert_eq!(
        hint(Some("SIGKILL"), 100, true, true),
        None,
        "mit game_kill beendet"
    );
    assert_eq!(hint(Some("SIGTERM"), 100, true, true), None);
    // sofortiges SIGKILL unter macOS: Quarantäne/Signatur
    let blocked = hint(Some("SIGKILL"), 120, false, true).unwrap();
    assert!(
        blocked.contains("xattr -dr com.apple.quarantine") && blocked.contains("Rechtsklick"),
        "{blocked}"
    );
    assert_eq!(
        hint(Some("SIGKILL"), 20_000, false, true),
        None,
        "nach langer Laufzeit ist es etwas anderes"
    );
    assert_eq!(
        hint(Some("SIGKILL"), 120, false, false),
        None,
        "unter Linux z. B. der OOM-Killer: nichts raten"
    );
    // Abstürze
    let crash = hint(Some("SIGSEGV"), 5_000, false, false).unwrap();
    assert!(
        crash.contains("abgestürzt (SIGSEGV)") && crash.contains("Firmware/BIOS"),
        "{crash}"
    );
    for signal in ["SIGBUS", "SIGABRT", "SIGTRAP", "SIGFPE", "SIGILL"] {
        assert!(
            hint(Some(signal), 10, false, false)
                .unwrap()
                .contains(&format!("abgestürzt ({signal})")),
            "{signal}"
        );
    }
    let rosetta = hint(Some("SIGILL"), 10, false, true).unwrap();
    assert!(
        rosetta.contains("arm64") && rosetta.contains("Rosetta"),
        "{rosetta}"
    );
}

#[test]
fn random_output_never_panics_the_line_cleaner() {
    // deterministisch (xorshift), damit ein Fehlschlag wiederholbar ist
    let mut state = 0x0123_4567_89AB_CDEFu64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for _ in 0..20_000 {
        let length = next() % 600;
        let bytes: Vec<u8> = (0..length).map(|_| (next() & 0xff) as u8).collect();
        let cleaned = clean_output_line(&bytes);
        assert!(
            cleaned.chars().count() <= 400,
            "zu lang: {}",
            cleaned.chars().count()
        );
        assert!(
            !cleaned.chars().any(char::is_control),
            "Steuerzeichen übrig: {cleaned:?}"
        );
    }
}

#[test]
fn random_paths_and_ids_never_panic_inspection_and_search() {
    let dir = TempDir::new("fuzz");
    let mut state = 0xFEED_FACE_DEAD_BEEFu64;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    const PIECES: &[&str] = &[
        "/", "..", ".", "~", "App.app", ".app", "Contents", "MacOS", "\u{0}", "ü", " ", "\\", "*",
        "%", "\n", "a",
    ];
    for _ in 0..3_000 {
        let path: String = (0..(next() % 8))
            .map(|_| PIECES[(next() % PIECES.len() as u64) as usize])
            .collect();
        let found = inspect(&path, dir.path());
        assert!(found.exists || found.executable.is_none());
        let _ = resolve_program(&path, dir.path());
        let hits = find_emulators(
            &SearchRoots {
                applications: vec![dir.path().to_path_buf()],
                ..SearchRoots::default()
            },
            None,
            &[spec("x", &path, &[&path])],
        );
        assert_eq!(hits.len(), 1);
    }
}
