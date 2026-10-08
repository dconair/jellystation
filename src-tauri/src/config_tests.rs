//! Prüft die Konfigurationsdateien, die sich beim Bauen unter Linux nicht auswirken oder erst zur Laufzeit scheitern würden:
//! `Info.plist` (nur macOS), die Regeln des Shell-Plugins (ein ungültiger regulärer Ausdruck lässt die App beim Start abstürzen)
//! und die Rechte unter `capabilities/`.

use regex::Regex;
use serde_json::Value;
use std::path::PathBuf;

fn manifest_file(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn read_json(relative: &str) -> Value {
    let text = std::fs::read_to_string(manifest_file(relative))
        .unwrap_or_else(|err| panic!("{relative}: {err}"));
    serde_json::from_str(&text)
        .unwrap_or_else(|err| panic!("{relative} ist kein gültiges JSON: {err}"))
}

/// So bildet das Shell-Plugin aus einem Eintrag den Ausdruck: `^…$` drumherum.
fn anchored(validator: &str) -> Regex {
    Regex::new(&format!("^{validator}$"))
        .unwrap_or_else(|err| panic!("ungültiger Ausdruck {validator}: {err}"))
}

#[test]
fn info_plist_can_be_read_by_tauri_and_has_the_required_keys() {
    // tauri-codegen liest die Datei bei macOS-Entwicklungsbuilds mit derselben Bibliothek und bricht sonst den Build ab.
    let value = plist::Value::from_file(manifest_file("Info.plist"))
        .expect("Info.plist muss sich lesen lassen");
    let dict = value
        .as_dictionary()
        .expect("Info.plist muss ein Dictionary sein");
    let ats = dict
        .get("NSAppTransportSecurity")
        .and_then(|v| v.as_dictionary())
        .expect("NSAppTransportSecurity fehlt");
    assert_eq!(
        ats.get("NSAllowsArbitraryLoads")
            .and_then(|v| v.as_boolean()),
        Some(true)
    );
    assert_eq!(
        ats.get("NSAllowsLocalNetworking")
            .and_then(|v| v.as_boolean()),
        Some(true)
    );
    assert_eq!(
        dict.get("NSLocalNetworkUsageDescription")
            .and_then(|v| v.as_string()),
        Some("JellyStation verbindet sich mit deinem Jellyfin-Server im lokalen Netzwerk.")
    );
    for key in [
        "NSDownloadsFolderUsageDescription",
        "NSDesktopFolderUsageDescription",
    ] {
        assert!(
            dict.get(key)
                .and_then(|v| v.as_string())
                .is_some_and(|t| t.contains("JellyStation")),
            "{key}"
        );
    }
}

#[test]
fn shell_open_only_allows_https_addresses() {
    let conf = read_json("tauri.conf.json");
    let open = conf["plugins"]["shell"]["open"]
        .as_str()
        .expect("plugins.shell.open muss ein Ausdruck sein");
    let regex = anchored(open);
    for good in [
        "https://rpcs3.net/download",
        "https://www.duckstation.org/",
        "https://pcsx2.net/downloads",
        "https://www.ppsspp.org/download",
        "https://dolphin-emu.org/download/",
        "https://github.com/RPCS3/rpcs3-binaries-mac/releases?x=1#y",
        "https://xn--bcher-kva.example/pfad%20mit%20kodierung",
    ] {
        assert!(regex.is_match(good), "{good} muss erlaubt sein");
    }
    for bad in [
        "http://rpcs3.net/download",
        "ftp://example.org/x",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "mailto:a@b.c",
        "tel:123",
        "--enable-debugging",
        "-i",
        "/R",
        "/Applications/RPCS3.app",
        "https://",
        "https:///nur-pfad",
        "https://user@host.example/",
        "https://host.example:8443/x",
        "https://evil.example/a b",
        "https://evil.example/a\nb",
        "https://evil.example/\n",
        " https://evil.example/",
        "xhttps://evil.example/",
        "https://evil.example/ --flag",
        "",
    ] {
        assert!(!regex.is_match(bad), "{bad:?} darf nicht erlaubt sein");
    }
}

fn permission_ids(capability: &Value) -> Vec<String> {
    capability["permissions"]
        .as_array()
        .expect("permissions fehlt")
        .iter()
        .map(|p| {
            p.as_str()
                .map(str::to_string)
                .or_else(|| p["identifier"].as_str().map(str::to_string))
                .expect("Berechtigung ohne Namen")
        })
        .collect()
}

#[test]
fn homebrew_scope_allows_only_cask_installs_with_a_safe_name() {
    let capability = read_json("capabilities/emulators.json");
    assert_eq!(capability["platforms"], serde_json::json!(["macOS"]));
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    let ids = permission_ids(&capability);
    assert_eq!(
        ids,
        ["shell:allow-spawn", "shell:allow-kill"],
        "keine weiteren Shell-Rechte (z. B. execute)"
    );

    let spawn = capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["identifier"] == "shell:allow-spawn")
        .unwrap();
    let entries = spawn["allow"].as_array().unwrap();
    assert_eq!(
        entries.len(),
        2,
        "nur brew-arm und brew-intel; die alten Einträge rpcs3/open-app entfallen"
    );
    let wanted = [
        ("brew-arm", "/opt/homebrew/bin/brew"),
        ("brew-intel", "/usr/local/bin/brew"),
    ];
    for (entry, (name, cmd)) in entries.iter().zip(wanted) {
        assert_eq!(entry["name"], name);
        assert_eq!(entry["cmd"], cmd);
        let args = entry["args"].as_array().unwrap();
        assert_eq!(args.len(), 3);
        assert_eq!(
            (&args[0], &args[1]),
            (&Value::from("install"), &Value::from("--cask"))
        );
        let validator = anchored(
            args[2]["validator"]
                .as_str()
                .expect("dritter Parameter braucht einen validator"),
        );
        for good in [
            "pcsx2",
            "ppsspp-emulator",
            "dolphin",
            "firefox@developer-edition",
            "a",
            "0ad",
            "notepad++",
            "font-fira.code",
            &"a".repeat(64),
        ] {
            assert!(validator.is_match(good), "{good} muss erlaubt sein");
        }
        for bad in [
            "",
            "-x",
            "--cask",
            "--help",
            "A",
            "pcsx2 ",
            " pcsx2",
            "a b",
            "a;b",
            "a/b",
            "../x",
            "a\nb",
            "a$(x)",
            "a`x`",
            "a&b",
            "a|b",
            "ä",
            &"a".repeat(65),
        ] {
            assert!(!validator.is_match(bad), "{bad:?} darf nicht erlaubt sein");
        }
    }
}

#[test]
fn every_capability_is_valid_json_and_targets_the_main_window() {
    let mut identifiers = Vec::new();
    for entry in std::fs::read_dir(manifest_file("capabilities"))
        .unwrap()
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".json") {
            continue;
        }
        let capability = read_json(&format!("capabilities/{name}"));
        assert_eq!(capability["windows"], serde_json::json!(["main"]), "{name}");
        identifiers.push(
            capability["identifier"]
                .as_str()
                .expect("identifier")
                .to_string(),
        );
        // Das alte Muster (Shell-Scope für rpcs3 / open) darf nirgends mehr auftauchen.
        let text = std::fs::read_to_string(entry.path()).unwrap();
        assert!(
            !text.contains("open-app") && !text.contains("\"rpcs3\""),
            "{name}"
        );
    }
    identifiers.sort();
    assert_eq!(identifiers, ["default", "emulators", "jellyfin", "library"]);
}

#[test]
fn default_capability_may_open_web_pages() {
    let ids = permission_ids(&read_json("capabilities/default.json"));
    assert!(ids.contains(&"shell:allow-open".to_string()), "{ids:?}");
    assert!(
        ids.contains(&"core:default".to_string()),
        "Ereignisse (game-exit) brauchen core:default"
    );
}
