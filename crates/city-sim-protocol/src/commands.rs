// SimCommand, CommandResult, Tool enum, and TileKind mapping for the sim protocol.
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

use crate::tile_kind::TileKind;

/// All tools the player can apply to the map.
///
/// Mirrors `Tool` in `src/game/toolTypes.ts`. Keep in sync — values are
/// serialised in command logs and must remain stable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[repr(u8)]
pub enum Tool {
    Inspect = 0,
    TerraformRaise = 1,
    TerraformLower = 2,
    Water = 3,
    Tree = 4,
    Road = 5,
    Rail = 6,
    PowerLine = 7,
    HydroPlant = 8,
    CoalPlant = 9,
    WindTurbine = 10,
    SolarFarm = 11,
    WaterPump = 12,
    WaterTower = 13,
    WaterPipe = 14,
    ElementarySchool = 15,
    HighSchool = 16,
    Residential = 17,
    Commercial = 18,
    Industrial = 19,
    Park = 20,
    Bulldoze = 21,
}

/// A command sent from the UI/bridge into the simulation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[non_exhaustive]
pub enum SimCommand {
    /// Apply a tool at tile coordinates (x, y).
    ApplyTool { tool: Tool, x: u16, y: u16 },
    /// Adjust simulation speed (multiplier relative to base tick rate).
    SetSpeed { multiplier: f32 },
    /// Load a complete new state (e.g. after save-file upload).
    LoadState { seed: u32 },
}

/// Result returned synchronously for `ApplyTool` commands.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub message: Option<String>,
}

impl CommandResult {
    pub fn ok() -> Self {
        Self {
            success: true,
            message: None,
        }
    }
    pub fn fail(msg: impl Into<String>) -> Self {
        Self {
            success: false,
            message: Some(msg.into()),
        }
    }
}

impl TryFrom<u8> for Tool {
    type Error = ();
    fn try_from(v: u8) -> Result<Self, ()> {
        if v <= Tool::Bulldoze as u8 {
            // SAFETY: Tool is #[repr(u8)] with contiguous discriminants 0..=21.
            Ok(unsafe { std::mem::transmute::<u8, Tool>(v) })
        } else {
            Err(())
        }
    }
}

/// Mapping from `Tool` to the `TileKind` it places, where applicable.
/// Returns `None` for tools that don't directly place a tile kind.
pub fn tool_to_tile_kind(tool: Tool) -> Option<TileKind> {
    match tool {
        Tool::Water => Some(TileKind::Water),
        Tool::Tree => Some(TileKind::Tree),
        Tool::Road => Some(TileKind::Road),
        Tool::Rail => Some(TileKind::Rail),
        Tool::PowerLine => Some(TileKind::PowerLine),
        Tool::HydroPlant => Some(TileKind::HydroPlant),
        Tool::CoalPlant => Some(TileKind::CoalPlant),
        Tool::WindTurbine => Some(TileKind::WindTurbine),
        Tool::SolarFarm => Some(TileKind::SolarFarm),
        Tool::WaterPump => Some(TileKind::WaterPump),
        Tool::WaterTower => Some(TileKind::WaterTower),
        Tool::WaterPipe => Some(TileKind::WaterPipe),
        Tool::ElementarySchool => Some(TileKind::ElementarySchool),
        Tool::HighSchool => Some(TileKind::HighSchool),
        Tool::Residential => Some(TileKind::Residential),
        Tool::Commercial => Some(TileKind::Commercial),
        Tool::Industrial => Some(TileKind::Industrial),
        Tool::Park => Some(TileKind::Park),
        Tool::Inspect | Tool::TerraformRaise | Tool::TerraformLower | Tool::Bulldoze => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use postcard::{from_bytes, to_allocvec};

    #[test]
    fn tool_try_from_u8_roundtrips() {
        for v in 0u8..=21 {
            let tool = Tool::try_from(v).expect("valid discriminant");
            assert_eq!(tool as u8, v);
        }
        assert!(Tool::try_from(22).is_err());
        assert!(Tool::try_from(255).is_err());
    }

    #[test]
    fn command_round_trips_postcard() {
        let cmd = SimCommand::ApplyTool {
            tool: Tool::Road,
            x: 5,
            y: 10,
        };
        let bytes = to_allocvec(&cmd).unwrap();
        let back: SimCommand = from_bytes(&bytes).unwrap();
        assert!(matches!(
            back,
            SimCommand::ApplyTool {
                tool: Tool::Road,
                x: 5,
                y: 10
            }
        ));
    }

    #[test]
    fn command_result_round_trips() {
        let r = CommandResult::fail("Not enough funds");
        let bytes = to_allocvec(&r).unwrap();
        let back: CommandResult = from_bytes(&bytes).unwrap();
        assert!(!back.success);
        assert_eq!(back.message.as_deref(), Some("Not enough funds"));
    }
}
