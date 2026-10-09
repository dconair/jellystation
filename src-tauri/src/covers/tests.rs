use super::image::testdata::{jpeg, png};
use super::testsupport::*;
use super::*;

const PS3_DIR: &str = "/Sony - PlayStation 3";

fn covers(base: &str) -> Covers {
    Covers::new(
        base,
        Duration::ZERO,
        Limits {
            connect: Duration::from_secs(2),
            total: Duration::from_secs(5),
        },
    )
}

fn request(system: &str, path: &str, title: &str, online: bool) -> CoverRequest {
    CoverRequest {
        system: system.into(),
        path: path.into(),
        title: title.into(),
        online,
        retry: false,
    }
}

fn ps3_iso(icon: Vec<u8>) -> Vec<u8> {
    build_iso(vec![dir(
        "PS3_GAME",
        vec![
            file("ICON0.PNG", icon),
            file(
                "PARAM.SFO",
                sfo(&[
                    ("TITLE", Sfo::Text("Gran Turismo® 5")),
                    ("TITLE_ID", Sfo::Text("BCES00569")),
                ]),
            ),
        ],
    )])
}

/// Dateien (Pfad → Antwort) hinter einem Server, der Verzeichnislisten und Bilder liefert.
fn site(
    listings: &'static [(&'static str, &'static [&'static str])],
    images: Vec<(String, Vec<u8>)>,
) -> impl Fn(&str) -> Reply + Send + Sync + 'static {
    move |path: &str| {
        for (dir, files) in listings {
            if path == *dir {
                return Reply::Body("text/html", listing_html(files));
            }
        }
        for (url, bytes) in &images {
            if path == url {
                return Reply::Body("image/png", bytes.clone());
            }
        }
        Reply::Status(404)
    }
}

fn boxart(name: &str) -> String {
    format!("{PS3_DIR}/Named_Boxarts/{name}")
}

const GOW_LIST: &[(&str, &[&str])] = &[(
    "/Sony - PlayStation 3/Named_Boxarts/",
    &[
        "God of War III (USA).png",
        "Gran Turismo 5 (Europe).png",
        "Uncharted 2 (Europe).png",
    ],
)];

#[tokio::test]
async fn online_boxart_wird_geholt_und_gespeichert() {
    let image = png(60, 80, 1);
    let mock = serve(site(
        GOW_LIST,
        vec![(boxart("God of War III (USA).png"), image.clone())],
    ))
    .await;
    let tmp = TempDir::new("online");
    let covers = covers(&mock.base);
    let req = request(
        "PS3",
        "/spiele/PS3/God of War III.iso",
        "God of War III",
        true,
    );

    let got = covers.resolve(tmp.path(), &req).await;
    assert_eq!(got.source, Some("online"));
    assert_eq!((got.width, got.height), (Some(60), Some(80)));
    assert_eq!(got.error, None);
    let path = PathBuf::from(got.path.unwrap());
    assert!(path.starts_with(tmp.path().join("ps3")), "{path:?}");
    assert_eq!(path.extension().unwrap(), "png");
    assert_eq!(
        fs::read(&path).unwrap(),
        image,
        "Bild wird unverändert gespeichert"
    );
    assert_eq!(
        mock.paths(),
        vec![
            "/Sony - PlayStation 3/Named_Boxarts/".to_string(),
            boxart("God of War III (USA).png")
        ]
    );
    let first = mock.first_request().to_lowercase();
    assert!(first.contains("user-agent: jellystation/"), "{first}");
    assert!(tmp.join("_listings").is_dir());

    // Beim zweiten Mal kommt es aus dem Cache – ohne eine einzige Anfrage
    let again = covers.resolve(tmp.path(), &req).await;
    assert_eq!(again.source, Some("cache"));
    assert_eq!(again.path, Some(path.to_string_lossy().into_owned()));
    assert_eq!(mock.count(), 2);
}

#[tokio::test]
async fn dateiliste_wird_nur_einmal_geholt_auch_nach_neustart() {
    let mock = serve(site(
        GOW_LIST,
        vec![
            (boxart("God of War III (USA).png"), png(60, 80, 1)),
            (boxart("Uncharted 2 (Europe).png"), png(60, 80, 2)),
        ],
    ))
    .await;
    let tmp = TempDir::new("liste");
    let first = covers(&mock.base);
    first
        .resolve(
            tmp.path(),
            &request("PS3", "/a/God of War III.iso", "God of War III", true),
        )
        .await;
    first
        .resolve(
            tmp.path(),
            &request("PS3", "/a/Uncharted 2.iso", "Uncharted 2", true),
        )
        .await;
    let listing_requests = |m: &Mock| {
        m.paths()
            .iter()
            .filter(|p| p.ends_with("Named_Boxarts/"))
            .count()
    };
    assert_eq!(listing_requests(&mock), 1);

    // Neue Instanz (App-Neustart): die Liste kommt von der Platte
    let second = covers(&mock.base);
    let got = second
        .resolve(
            tmp.path(),
            &request("PS3", "/a/Gran Turismo 5.iso", "Gran Turismo 5", true),
        )
        .await;
    assert_eq!(
        got.path, None,
        "für Gran Turismo gibt es in der Liste, aber nicht als Datei ein Bild"
    );
    assert_eq!(listing_requests(&mock), 1);
}

#[tokio::test]
async fn abgelaufene_liste_wird_neu_geholt_und_bleibt_bei_netzfehlern_nutzbar() {
    let mock = serve(site(
        GOW_LIST,
        vec![(boxart("God of War III (USA).png"), png(60, 80, 1))],
    ))
    .await;
    let tmp = TempDir::new("liste-alt");
    let file = tmp
        .join("_listings")
        .join("sony-playstation-3-named-boxarts.txt");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    let old = now_secs() - LISTING_TTL_SECS - 100;
    fs::write(&file, format!("# {old}\nGod of War III (USA).png\n")).unwrap();

    let got = covers(&mock.base)
        .resolve(
            tmp.path(),
            &request("PS3", "/a/God of War III.iso", "God of War III", true),
        )
        .await;
    assert_eq!(got.source, Some("online"));
    assert!(
        mock.paths()[0].ends_with("Named_Boxarts/"),
        "Liste neu geholt: {:?}",
        mock.paths()
    );
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains("Uncharted 2 (Europe).png"), "Liste erneuert");

    // Server weg: die alte Liste hilft weiter
    let dead = TempDir::new("liste-tot");
    let file = dead
        .join("_listings")
        .join("sony-playstation-3-named-boxarts.txt");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, format!("# {old}\nGod of War III (USA).png\n")).unwrap();
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let got = covers(&closed)
        .resolve(
            dead.path(),
            &request("PS3", "/a/God of War III.iso", "God of War III", true),
        )
        .await;
    assert_eq!(got.path, None);
    assert!(
        got.error.is_some(),
        "das Bild selbst ließ sich nicht holen: {got:?}"
    );
}

#[tokio::test]
async fn ohne_boxart_kommt_der_snap_dann_das_titelbild() {
    static LISTS: &[(&str, &[&str])] = &[
        (
            "/Sony - PlayStation 3/Named_Boxarts/",
            &["Etwas Anderes (USA).png"],
        ),
        (
            "/Sony - PlayStation 3/Named_Snaps/",
            &[
                "Etwas Anderes (USA).png",
                "Tekken Tag Tournament 2 (Europe).png",
            ],
        ),
        (
            "/Sony - PlayStation 3/Named_Titles/",
            &["Journey (USA).png"],
        ),
    ];
    let snap = png(80, 45, 5);
    let title = png(80, 45, 6);
    let mock = serve(site(
        LISTS,
        vec![
            (
                "/Sony - PlayStation 3/Named_Snaps/Tekken Tag Tournament 2 (Europe).png".into(),
                snap.clone(),
            ),
            (
                "/Sony - PlayStation 3/Named_Titles/Journey (USA).png".into(),
                title.clone(),
            ),
        ],
    ))
    .await;
    let tmp = TempDir::new("snaps");
    let covers = covers(&mock.base);

    let got = covers
        .resolve(
            tmp.path(),
            &request(
                "PS3",
                "/a/Tekken Tag Tournament 2.iso",
                "Tekken Tag Tournament 2",
                true,
            ),
        )
        .await;
    assert_eq!(fs::read(got.path.unwrap()).unwrap(), snap);
    let got = covers
        .resolve(
            tmp.path(),
            &request("PS3", "/a/Journey.iso", "Journey", true),
        )
        .await;
    assert_eq!(fs::read(got.path.unwrap()).unwrap(), title);
}

#[tokio::test]
async fn ohne_dateiliste_werden_die_namen_direkt_versucht() {
    // Kein Verzeichnislisting (404): der Dateiname wird so versucht, wie libretro ihn anlegt
    let image = png(60, 80, 3);
    let mock = serve(site(
        &[],
        vec![(boxart("Ratchet _ Clank_ Size Matters.png"), image.clone())],
    ))
    .await;
    let tmp = TempDir::new("direkt");
    let got = covers(&mock.base)
        .resolve(
            tmp.path(),
            &request("PS3", "/a/x.iso", "Ratchet & Clank: Size Matters", true),
        )
        .await;
    assert_eq!(got.source, Some("online"), "{got:?}");
    assert_eq!(fs::read(got.path.unwrap()).unwrap(), image);
}

#[tokio::test]
async fn nicht_gefundenes_wird_sieben_tage_gemerkt() {
    let flip = Arc::new(Mutex::new(false));
    let handler_flip = flip.clone();
    let image = png(60, 80, 1);
    let mock = serve(move |path: &str| {
        let present = *handler_flip.lock().unwrap();
        if path == "/Sony - PlayStation 3/Named_Boxarts/" {
            let files: &[&str] = if present {
                &["Pixel Pilot (USA).png"]
            } else {
                &["Etwas Anderes (USA).png"]
            };
            Reply::Body("text/html", listing_html(files))
        } else if path == boxart("Pixel Pilot (USA).png") {
            Reply::Body("image/png", image.clone())
        } else {
            Reply::Status(404)
        }
    })
    .await;
    let tmp = TempDir::new("miss");
    let covers = covers(&mock.base);
    let req = request("PS3", "/a/Pixel Pilot.iso", "Pixel Pilot", true);

    let none = covers.resolve(tmp.path(), &req).await;
    assert_eq!((none.path.clone(), none.error.clone()), (None, None));
    let key = cache_key("PS3", "Pixel Pilot");
    let marker = tmp.join("ps3").join(format!("{key}.miss"));
    assert!(fs::read_to_string(&marker)
        .unwrap()
        .starts_with("notfound "));

    // Jetzt gäbe es das Bild – aber der Merker verhindert die Suche
    *flip.lock().unwrap() = true;
    covers.forget_listings();
    fs::remove_file(
        tmp.join("_listings")
            .join("sony-playstation-3-named-boxarts.txt"),
    )
    .unwrap();
    let before = mock.count();
    assert_eq!(covers.resolve(tmp.path(), &req).await.path, None);
    assert_eq!(mock.count(), before, "keine Anfrage während der Sperrfrist");

    // Manuelle Suche (retry) ignoriert den Merker
    let forced = CoverRequest {
        retry: true,
        ..req.clone()
    };
    let got = covers.resolve(tmp.path(), &forced).await;
    assert_eq!(got.source, Some("online"));
    assert!(!marker.exists(), "Merker gelöscht, sobald ein Cover da ist");
}

#[tokio::test]
async fn abgelaufener_merker_sucht_erneut() {
    let image = png(60, 80, 1);
    let mock = serve(site(
        GOW_LIST,
        vec![(boxart("God of War III (USA).png"), image)],
    ))
    .await;
    let tmp = TempDir::new("miss-alt");
    let key = cache_key("PS3", "God of War III");
    let marker = tmp.join("ps3").join(format!("{key}.miss"));
    fs::create_dir_all(marker.parent().unwrap()).unwrap();
    let req = request("PS3", "/a/God of War III.iso", "God of War III", true);

    fs::write(
        &marker,
        Miss::NotFound(now_secs() - MISS_TTL_SECS + 3600).text(),
    )
    .unwrap();
    assert_eq!(
        covers(&mock.base).resolve(tmp.path(), &req).await.path,
        None
    );
    assert_eq!(mock.count(), 0);

    fs::write(
        &marker,
        Miss::NotFound(now_secs() - MISS_TTL_SECS - 1).text(),
    )
    .unwrap();
    assert_eq!(
        covers(&mock.base).resolve(tmp.path(), &req).await.source,
        Some("online")
    );
}

#[test]
fn merker_dauer_und_format() {
    let now = 1_000_000;
    assert!(Miss::NotFound(now - MISS_TTL_SECS + 1).active(now));
    assert!(!Miss::NotFound(now - MISS_TTL_SECS).active(now));
    assert!(Miss::NetError(now - NET_ERROR_TTL_SECS + 1).active(now));
    assert!(!Miss::NetError(now - NET_ERROR_TTL_SECS).active(now));
    for miss in [Miss::NotFound(42), Miss::NetError(7)] {
        assert_eq!(Miss::parse(&miss.text()), Some(miss));
    }
    for bad in ["", "notfound", "notfound x", "other 5", "5"] {
        assert_eq!(Miss::parse(bad), None, "{bad}");
    }
    // Ein Zeitstempel in der Zukunft darf nicht überlaufen
    assert!(Miss::NotFound(u64::MAX).active(5));
}

#[tokio::test]
async fn netzfehler_werden_gemeldet_und_kurz_gemerkt() {
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let tmp = TempDir::new("netz");
    let covers = covers(&closed);
    let started = Instant::now();
    let first = covers
        .resolve(
            tmp.path(),
            &request("PS3", "/a/God of War III.iso", "God of War III", true),
        )
        .await;
    assert_eq!(first.path, None);
    assert!(
        first
            .error
            .as_deref()
            .is_some_and(|e| e.contains("Keine Verbindung")),
        "{first:?}"
    );
    let marker = tmp
        .join("ps3")
        .join(format!("{}.miss", cache_key("PS3", "God of War III")));
    assert!(fs::read_to_string(&marker).unwrap().starts_with("neterr "));

    // Weitere Spiele warten nicht erneut auf den Verbindungsaufbau
    for title in ["Uncharted 2", "Journey", "Demon's Souls"] {
        let got = covers
            .resolve(tmp.path(), &request("PS3", "/a/x.iso", title, true))
            .await;
        assert!(got.error.is_some());
    }
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );

    // Nach zehn Minuten wird neu versucht – hier gelingt es, weil der Server wieder da ist
    let mock = serve(site(
        GOW_LIST,
        vec![(boxart("God of War III (USA).png"), png(60, 80, 1))],
    ))
    .await;
    fs::write(
        &marker,
        Miss::NetError(now_secs() - NET_ERROR_TTL_SECS - 1).text(),
    )
    .unwrap();
    let back = self::covers(&mock.base);
    let got = back
        .resolve(
            tmp.path(),
            &request("PS3", "/a/God of War III.iso", "God of War III", true),
        )
        .await;
    assert_eq!(got.source, Some("online"));
}

#[tokio::test]
async fn zeitlimit_greift_bei_haengendem_server() {
    let mock = serve(|_: &str| Reply::Hang).await;
    let tmp = TempDir::new("hang");
    let covers = Covers::new(
        &mock.base,
        Duration::ZERO,
        Limits {
            connect: Duration::from_millis(300),
            total: Duration::from_millis(600),
        },
    );
    let started = Instant::now();
    let got = covers
        .resolve(
            tmp.path(),
            &request("PS3", "/a/x.iso", "God of War III", true),
        )
        .await;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(got.path, None);
    assert!(got.error.is_some());
}

#[tokio::test]
async fn zu_grosse_bilder_werden_nicht_gespeichert() {
    let mock = serve(|path: &str| {
        if path.ends_with('/') {
            Reply::Body("text/html", listing_html(&["God of War III (USA).png"]))
        } else {
            let mut data = png(10, 10, 0);
            data.resize(MAX_IMAGE_BYTES + 1, 0);
            Reply::Body("image/png", data)
        }
    })
    .await;
    let tmp = TempDir::new("gross");
    let got = covers(&mock.base)
        .resolve(
            tmp.path(),
            &request("PS3", "/a/x.iso", "God of War III", true),
        )
        .await;
    assert_eq!(got.path, None);
    assert!(!tmp
        .join("ps3")
        .read_dir()
        .unwrap()
        .flatten()
        .any(|e| e.path().extension().is_some_and(|x| x == "png")));
}

#[tokio::test]
async fn nur_echte_bilder_werden_gespeichert() {
    for body in [
        b"<html><body>Not Found</body></html>".to_vec(),
        b"GIF89a\x01\x00\x01\x00".to_vec(),
        noise(2000, 1),
        {
            let mut cut = png(60, 80, 1);
            cut.truncate(cut.len() - 20);
            cut
        },
    ] {
        let served = body.clone();
        let mock = serve(move |path: &str| {
            if path.ends_with('/') {
                Reply::Body("text/html", listing_html(&["God of War III (USA).png"]))
            } else {
                Reply::Body("image/png", served.clone())
            }
        })
        .await;
        let tmp = TempDir::new("kein-bild");
        let got = covers(&mock.base)
            .resolve(
                tmp.path(),
                &request("PS3", "/a/x.iso", "God of War III", true),
            )
            .await;
        assert_eq!(got.path, None);
        let stats = cache_stats(tmp.path());
        assert_eq!(stats.count, 0, "kein Bild im Cache");
    }
}

#[tokio::test]
async fn jpeg_wird_als_jpg_abgelegt() {
    let data = jpeg(500, 700);
    let served = data.clone();
    let mock = serve(move |path: &str| {
        if path.ends_with('/') {
            Reply::Body("text/html", listing_html(&["God of War III (USA).png"]))
        } else {
            Reply::Body("image/jpeg", served.clone())
        }
    })
    .await;
    let tmp = TempDir::new("jpg");
    let got = covers(&mock.base)
        .resolve(
            tmp.path(),
            &request("PS3", "/a/x.iso", "God of War III", true),
        )
        .await;
    let path = PathBuf::from(got.path.unwrap());
    assert_eq!(path.extension().unwrap(), "jpg");
    assert_eq!((got.width, got.height), (Some(500), Some(700)));
    assert_eq!(fs::read(path).unwrap(), data);
}

#[tokio::test]
async fn weiterleitungen_nur_innerhalb_desselben_hosts() {
    let image = png(60, 80, 1);
    let served = image.clone();
    let mock = serve(move |path: &str| match path {
        "/Sony - PlayStation 3/Named_Boxarts/" => Reply::Body(
            "text/html",
            listing_html(&["Same (USA).png", "Fremd (USA).png"]),
        ),
        p if p == boxart("Same (USA).png") => Reply::Redirect("/echt/same.png".into()),
        "/echt/same.png" => Reply::Body("image/png", served.clone()),
        p if p == boxart("Fremd (USA).png") => Reply::Redirect("http://fremd.invalid/x.png".into()),
        _ => Reply::Status(404),
    })
    .await;
    let tmp = TempDir::new("redirect");
    let covers = covers(&mock.base);
    let same = covers
        .resolve(tmp.path(), &request("PS3", "/a/x.iso", "Same", true))
        .await;
    assert_eq!(fs::read(same.path.unwrap()).unwrap(), image);
    let other = covers
        .resolve(tmp.path(), &request("PS3", "/a/x.iso", "Fremd", true))
        .await;
    assert_eq!(other.path, None);
    assert_eq!(other.error, None, "kein Netzfehler, nur nichts gefunden");
}

#[tokio::test]
async fn online_false_fasst_das_netz_nicht_an() {
    let mock = serve(site(
        GOW_LIST,
        vec![(boxart("God of War III (USA).png"), png(60, 80, 1))],
    ))
    .await;
    let tmp = TempDir::new("offline");
    let covers = covers(&mock.base);
    for title in ["God of War III", "Gran Turismo 5", "Unbekannt"] {
        let got = covers
            .resolve(tmp.path(), &request("PS3", "/a/x.iso", title, false))
            .await;
        assert_eq!(got.path, None);
        assert_eq!(got.error, None);
    }
    assert_eq!(mock.count(), 0);
    assert!(!tmp.join("_listings").exists());
    assert!(!tmp.join("ps3").exists(), "auch keine Merker");
}

#[tokio::test]
async fn eingebettetes_icon_braucht_kein_netz() {
    let mock = serve(site(GOW_LIST, vec![])).await;
    let tmp = TempDir::new("embedded");
    let games = TempDir::new("embedded-games");
    let icon = png(320, 176, 2);
    let iso = games.join("Gran Turismo 5.iso");
    fs::write(&iso, ps3_iso(icon.clone())).unwrap();
    let covers = covers(&mock.base);

    for online in [false, true] {
        let req = request("PS3", iso.to_str().unwrap(), "Gran Turismo 5", online);
        let first = covers.resolve(tmp.path(), &req).await;
        let path = PathBuf::from(first.path.clone().unwrap());
        assert!(
            first.source == Some("embedded") || first.source == Some("cache"),
            "{first:?}"
        );
        assert!(first.serial.is_none() || first.serial.as_deref() == Some("BCES00569"));
        assert_eq!((first.width, first.height), (Some(320), Some(176)));
        assert_eq!(fs::read(path).unwrap(), icon, "Grafik unverändert");
    }
    assert_eq!(
        mock.count(),
        0,
        "eingebettetes Bild: keine Netzanfrage, auch bei online = true"
    );
    assert_eq!(
        covers
            .resolve(
                tmp.path(),
                &request("PS3", iso.to_str().unwrap(), "Gran Turismo 5", true)
            )
            .await
            .source,
        Some("cache")
    );
}

#[tokio::test]
async fn verschluesseltes_abbild_weicht_auf_online_aus() {
    let mock = serve(site(
        GOW_LIST,
        vec![(boxart("Gran Turismo 5 (Europe).png"), png(60, 80, 9))],
    ))
    .await;
    let tmp = TempDir::new("enc");
    let games = TempDir::new("enc-games");
    let iso = games.join("Spiel 1.iso");
    // Das Icon ist verschlüsselt (kein PNG), der Titel aus der SFO ist lesbar
    fs::write(&iso, ps3_iso(noise(5000, 4))).unwrap();
    let got = covers(&mock.base)
        .resolve(
            tmp.path(),
            &request("PS3", iso.to_str().unwrap(), "Spiel 1", true),
        )
        .await;
    assert_eq!(got.source, Some("online"), "{got:?}");
    assert_eq!(got.serial.as_deref(), Some("BCES00569"));
}

#[tokio::test]
async fn systemordner_mit_fremdem_namen_nimmt_system_aus_dem_inhalt() {
    let mock = serve(site(
        GOW_LIST,
        vec![(boxart("Gran Turismo 5 (Europe).png"), png(60, 80, 9))],
    ))
    .await;
    let tmp = TempDir::new("plat");
    let games = TempDir::new("plat-games");
    let iso = games.join("GT.iso");
    fs::write(&iso, ps3_iso(noise(5000, 4))).unwrap();
    let got = covers(&mock.base)
        .resolve(
            tmp.path(),
            &request("Meine Spiele", iso.to_str().unwrap(), "GT", true),
        )
        .await;
    assert_eq!(got.source, Some("online"), "{got:?}");
    // Unbekannter Ordner ohne erkennbaren Inhalt: nichts zu suchen
    let none = covers(&mock.base)
        .resolve(
            tmp.path(),
            &request("Meine Spiele", "/gibt/es/nicht.iso", "Irgendwas", true),
        )
        .await;
    assert_eq!(none, CoverResult::default());
}

#[tokio::test]
async fn hoechstens_zwei_gleichzeitige_abrufe() {
    static LISTS: &[(&str, &[&str])] = &[(
        "/Sony - PlayStation 3/Named_Boxarts/",
        &[
            "Spiel A (USA).png",
            "Spiel B (USA).png",
            "Spiel C (USA).png",
            "Spiel D (USA).png",
            "Spiel E (USA).png",
            "Spiel F (USA).png",
        ],
    )];
    let image = png(60, 80, 1);
    let mock = serve(move |path: &str| {
        if path.ends_with('/') {
            Reply::Body("text/html", listing_html(LISTS[0].1))
        } else if path.contains("Spiel") {
            Reply::Slow(
                Duration::from_millis(150),
                Box::new(Reply::Body("image/png", image.clone())),
            )
        } else {
            Reply::Status(404)
        }
    })
    .await;
    let tmp = TempDir::new("parallel");
    let covers = covers(&mock.base);
    let reqs: Vec<CoverRequest> = ["A", "B", "C", "D", "E", "F"]
        .iter()
        .map(|n| request("PS3", "/a/x.iso", &format!("Spiel {n}"), true))
        .collect();
    let all =
        futures_util::future::join_all(reqs.iter().map(|r| covers.resolve(tmp.path(), r))).await;
    assert!(all.iter().all(|r| r.source == Some("online")), "{all:?}");
    assert!(
        mock.peak.load(Ordering::SeqCst) <= MAX_PARALLEL,
        "gleichzeitig: {}",
        mock.peak.load(Ordering::SeqCst)
    );
    assert_eq!(
        mock.paths().iter().filter(|p| p.ends_with('/')).count(),
        1,
        "Liste nur einmal"
    );
}

#[tokio::test]
async fn pfadtricks_landen_nie_ausserhalb_des_cache() {
    let image = png(60, 80, 1);
    let mock = serve(move |path: &str| {
        if path.ends_with('/') {
            Reply::Body("text/html", listing_html(&["evil (USA).png"]))
        } else {
            Reply::Body("image/png", image.clone())
        }
    })
    .await;
    let tmp = TempDir::new("traversal");
    let root = tmp.join("cache").join("covers");
    let covers = covers(&mock.base);
    for (system, title) in [
        ("../../etc", "../../../evil"),
        ("..", ".."),
        ("/etc/passwd", "/etc/passwd"),
        ("PS3/../../x", "evil/../../../x"),
        ("PS3\\..\\..\\x", "evil"),
    ] {
        // Systemname bleibt unerkannt – deshalb über einen echten Ordner mit PS3-Inhalt
        let games = TempDir::new("traversal-games");
        let iso = games.join("e.iso");
        fs::write(&iso, ps3_iso(noise(5000, 4))).unwrap();
        let got = covers
            .resolve(&root, &request(system, iso.to_str().unwrap(), title, true))
            .await;
        if let Some(path) = got.path {
            let path = PathBuf::from(path);
            assert!(path.starts_with(&root), "{system} → {path:?}");
            assert!(!path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir)));
        }
    }
    let mut escaped = Vec::new();
    for entry in fs::read_dir(tmp.path()).unwrap().flatten() {
        escaped.push(entry.file_name().to_string_lossy().into_owned());
    }
    assert_eq!(escaped, ["cache"], "nichts neben dem Cache-Ordner angelegt");
}

#[tokio::test]
async fn gleicher_titel_in_anderen_systemen_ist_getrennt() {
    let mock = serve(site(
        GOW_LIST,
        vec![(boxart("God of War III (USA).png"), png(60, 80, 1))],
    ))
    .await;
    let tmp = TempDir::new("systeme");
    let covers = covers(&mock.base);
    let ps3 = covers
        .resolve(
            tmp.path(),
            &request("PS3", "/a/God of War III.iso", "God of War III", true),
        )
        .await;
    assert_eq!(ps3.source, Some("online"));
    let other = covers
        .resolve(
            tmp.path(),
            &request("Wii", "/a/God of War III.iso", "God of War III", true),
        )
        .await;
    assert_ne!(other.source, Some("cache"));
    assert_ne!(cache_key("PS3", "x"), cache_key("PS2", "x"));
}

#[tokio::test]
async fn leerer_titel_nimmt_den_dateinamen() {
    let mock = serve(site(
        GOW_LIST,
        vec![(boxart("God of War III (USA).png"), png(60, 80, 1))],
    ))
    .await;
    let tmp = TempDir::new("titel");
    let req = request("PS3", "/a/b/God of War III.iso", "  ", true);
    assert_eq!(req.game_name(), "God of War III");
    let got = covers(&mock.base).resolve(tmp.path(), &req).await;
    assert_eq!(got.source, Some("online"));
}

#[test]
fn cache_schluessel() {
    let key = cache_key("PS3", "God of War III");
    assert_eq!(key.len(), 16);
    assert!(key.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(key, cache_key(" ps3 ", "god of war iii"));
    assert_ne!(key, cache_key("PS3", "God of War II"));
    assert_ne!(cache_key("a", "bc"), cache_key("ab", "c"));
}

#[test]
fn anfrage_wird_geprueft() {
    assert!(request("PS3", "/a/b.iso", "x", true).validate().is_ok());
    assert!(request("", "/a/b.iso", "x", true).validate().is_err());
    assert!(request("   ", "/a/b.iso", "x", true).validate().is_err());
    assert!(request(&"x".repeat(65), "/a/b.iso", "x", true)
        .validate()
        .is_err());
    assert!(request("PS3", "", "x", true).validate().is_err());
    assert!(request("PS3", &"x".repeat(5000), "x", true)
        .validate()
        .is_err());
    assert!(request("PS3", "/a", &"x".repeat(600), true)
        .validate()
        .is_err());
}

#[test]
fn http_nur_bei_eigener_adresse() {
    let default = Covers::new(DEFAULT_BASE, Duration::ZERO, Limits::default());
    assert!(!default.custom_base);
    assert!(default.client().is_ok());
    let custom = Covers::new("http://127.0.0.1:9/", Duration::ZERO, Limits::default());
    assert!(custom.custom_base);
    assert_eq!(custom.base, "http://127.0.0.1:9");
    assert_eq!(Limits::default().connect, Duration::from_secs(8));
    assert_eq!(Limits::default().total, Duration::from_secs(20));
    assert_eq!(DEFAULT_BASE, "https://thumbnails.libretro.com");
}

#[test]
fn cache_zaehlen_und_leeren() {
    let tmp = TempDir::new("stats");
    let root = tmp.join("covers");
    fs::create_dir_all(root.join("ps3")).unwrap();
    fs::create_dir_all(root.join("_listings")).unwrap();
    fs::write(root.join("ps3/aaaa.png"), vec![1u8; 1000]).unwrap();
    fs::write(root.join("ps3/bbbb.jpg"), vec![1u8; 500]).unwrap();
    fs::write(root.join("ps3/cccc.miss"), b"notfound 1\n").unwrap();
    fs::write(root.join("_listings/x.txt"), vec![b'a'; 200]).unwrap();
    let outside = tmp.join("fremd.png");
    fs::write(&outside, b"nicht anfassen").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("ps3/link.png")).unwrap();

    let stats = cache_stats(&root);
    assert_eq!(stats.count, 2);
    assert_eq!(stats.bytes, 1000 + 500 + 11 + 200);

    let (removed, bytes) = cache_clear(&root);
    assert_eq!(removed, 2);
    assert_eq!(bytes, 1711);
    assert_eq!(cache_stats(&root), CacheStats::default());
    assert!(outside.exists(), "Dateien außerhalb bleiben unberührt");
    assert!(!root.join("_listings").exists());
    assert!(root.exists());
    // Ein leerer oder fehlender Cache ist kein Fehler
    assert_eq!(cache_clear(&tmp.join("gibt-es-nicht")), (0, 0));
    assert_eq!(
        cache_stats(&tmp.join("gibt-es-nicht")),
        CacheStats::default()
    );
}

#[tokio::test]
async fn leeren_vergisst_auch_die_listen_im_speicher() {
    let mock = serve(site(
        GOW_LIST,
        vec![(boxart("God of War III (USA).png"), png(60, 80, 1))],
    ))
    .await;
    let tmp = TempDir::new("leeren");
    let covers = covers(&mock.base);
    let req = request("PS3", "/a/God of War III.iso", "God of War III", true);
    covers.resolve(tmp.path(), &req).await;
    assert_eq!(cache_stats(tmp.path()).count, 1);
    cache_clear(tmp.path());
    covers.forget_listings();
    let again = covers.resolve(tmp.path(), &req).await;
    assert_eq!(again.source, Some("online"));
    assert_eq!(mock.paths().iter().filter(|p| p.ends_with('/')).count(), 2);
}

#[test]
fn atomar_schreiben() {
    let tmp = TempDir::new("atomic");
    let target = tmp.join("neu/ordner/bild.png");
    write_atomic(&target, b"eins").unwrap();
    write_atomic(&target, b"zwei").unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"zwei");
    let leftovers: Vec<_> = fs::read_dir(target.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(leftovers, ["bild.png"], "keine temporären Dateien");

    // Scheitert das Umbenennen (Ziel ist ein Ordner), bleibt nichts liegen
    let blocked = tmp.join("blockiert.png");
    fs::create_dir_all(blocked.join("inhalt")).unwrap();
    assert!(write_atomic(&blocked, b"x").is_err());
    let names: Vec<_> = fs::read_dir(tmp.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(names.iter().all(|n| !n.ends_with(".tmp")), "{names:?}");
}

#[test]
fn leere_cache_datei_zaehlt_nicht() {
    let tmp = TempDir::new("leer");
    fs::write(tmp.join("abc.png"), b"").unwrap();
    assert_eq!(find_cached(tmp.path(), "abc"), None);
    fs::write(tmp.join("abc.jpg"), b"x").unwrap();
    assert_eq!(find_cached(tmp.path(), "abc"), Some(tmp.join("abc.jpg")));
}
