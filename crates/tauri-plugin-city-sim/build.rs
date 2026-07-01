const COMMANDS: &[&str] = &[
    "start",
    "apply_tool",
    "set_speed",
    "stop",
    "get_snapshot",
    "load_snapshot",
    "get_map_seed",
    "get_command_log",
    "load_command_log",
    "undo_last_command",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
