const COMMANDS: &[&str] = &[
    "start",
    "apply_tool",
    "set_speed",
    "set_policies",
    "set_natural_terrain",
    "stop",
    "get_snapshot",
    "load_snapshot",
    "import_legacy",
    "get_map_seed",
    "undo",
    "redo",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
