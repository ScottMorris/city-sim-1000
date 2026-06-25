const COMMANDS: &[&str] = &["start", "apply_tool", "set_speed", "stop"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
