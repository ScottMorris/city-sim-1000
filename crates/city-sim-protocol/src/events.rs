// events.rs — messages emitted by the simulation back to the UI.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use ts_rs::TS;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, TS)]
#[ts(export_to = "SimAlert.ts")]
pub struct SimAlert {
    pub kind: AlertKind,
    pub message: String,
    /// If true the alert stays visible until cleared; if false it's a toast.
    pub sticky: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, TS)]
#[ts(export_to = "AlertKind.ts")]
pub enum AlertKind {
    PowerDeficit,
    PowerRestored,
    WaterDeficit,
    WaterRestored,
    BudgetWarning,
    Abandonment,
    Info,
}

#[cfg(test)]
mod tests {
    use super::*;
    use postcard::{from_bytes, to_allocvec};

    #[test]
    fn alert_round_trips_postcard() {
        let alert = SimAlert {
            kind: AlertKind::PowerDeficit,
            message: "Power deficit!".into(),
            sticky: true,
        };
        let bytes = to_allocvec(&alert).unwrap();
        let back: SimAlert = from_bytes(&bytes).unwrap();
        assert_eq!(back.kind, AlertKind::PowerDeficit);
        assert_eq!(back.message, "Power deficit!");
        assert!(back.sticky);
    }
}
