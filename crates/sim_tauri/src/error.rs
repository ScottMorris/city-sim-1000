use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("simulation is not running — call start first")]
    NotStarted,
    #[error("simulation channel closed")]
    ChannelClosed,
    #[error("unknown tool id: {0}")]
    InvalidTool(u8),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
