/// Messages emitted by the simulation back to the UI.
///
/// Mirrors the TS `SimulationAlert` and `SimEvent` union but expressed as a
/// single flat enum for clean serialisation over the bridge.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[non_exhaustive]
pub enum FromSim {
    /// A sticky or toast alert for the HUD (power deficit, budget warning, etc.).
    Alert(SimAlert),
    /// A narrative event routed to the ticker / insights panel.
    Narrative(NarrativeEvent),
    /// Acknowledgement of a SimCommand with success/failure and optional message.
    CommandResult {
        success: bool,
        message: Option<String>,
    },
    /// Emitted once per tick — carries lightweight system stats for the HUD.
    TickStats(TickStats),
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SimAlert {
    pub kind: AlertKind,
    pub message: String,
    /// If true the alert stays visible until cleared; if false it's a toast.
    pub sticky: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AlertKind {
    PowerDeficit,
    PowerRestored,
    WaterDeficit,
    WaterRestored,
    BudgetWarning,
    Abandonment,
    Info,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NarrativeEvent {
    pub kind: NarrativeKind,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum NarrativeKind {
    MonthEnd,
    Milestone,
    Alert,
}

/// Lightweight per-tick stats surfaced to the HUD without a full state copy.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TickStats {
    pub tick: u32,
    pub day: f32,
    pub money: f32,
    pub population: u32,
    pub jobs: u32,
    pub power_balance: f32,
    pub water_balance: f32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use postcard::{from_bytes, to_allocvec};

    #[test]
    fn alert_round_trips_postcard() {
        let msg = FromSim::Alert(SimAlert {
            kind: AlertKind::PowerDeficit,
            message: "Power deficit!".into(),
            sticky: true,
        });
        let bytes = to_allocvec(&msg).unwrap();
        let back: FromSim = from_bytes(&bytes).unwrap();
        assert!(matches!(back, FromSim::Alert(_)));
    }

    #[test]
    fn tick_stats_round_trips_postcard() {
        let stats = FromSim::TickStats(TickStats {
            tick: 42,
            day: 3.5,
            money: 99500.0,
            population: 250,
            jobs: 80,
            power_balance: 12.0,
            water_balance: 8.0,
        });
        let bytes = to_allocvec(&stats).unwrap();
        let back: FromSim = from_bytes(&bytes).unwrap();
        assert!(matches!(back, FromSim::TickStats(s) if s.tick == 42));
    }
}
