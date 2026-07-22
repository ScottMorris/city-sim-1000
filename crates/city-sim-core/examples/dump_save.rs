// Temporary debug tool: decode a CSAV file's engine snapshot and print
// utility/building stats, then step the sim and print again.
use city_sim_core::buildings::{get_building_template, BuildingStatus};
use city_sim_core::sim::Simulation;
use city_sim_core::snapshot;
use std::collections::BTreeMap;

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: dump_save <file.citysim>");
    let bytes = std::fs::read(path).expect("read save");
    assert_eq!(&bytes[0..4], b"CSAV");
    let meta_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let engine_off = 12 + meta_len;
    let engine_len =
        u32::from_le_bytes(bytes[engine_off..engine_off + 4].try_into().unwrap()) as usize;
    let blob = &bytes[engine_off + 4..engine_off + 4 + engine_len];
    let state = snapshot::from_bytes(blob).expect("decode CSIM");

    println!(
        "tick={} day={} money={} pop={} jobs={}",
        state.tick, state.day, state.money, state.population, state.jobs
    );
    println!("utilities: {:?}", state.utilities);
    println!(
        "fund_power={} policies={:?}",
        state.policies.budget.fund_power, state.policies.wilderness
    );

    let mut by_status: BTreeMap<String, u32> = BTreeMap::new();
    let mut power_use_sum = 0.0f32;
    let mut per_kind: BTreeMap<String, (u32, f32)> = BTreeMap::new();
    for b in &state.buildings {
        *by_status.entry(format!("{:?}", b.status)).or_default() += 1;
        if b.status == BuildingStatus::Active {
            if let Some(t) = get_building_template(b.kind) {
                power_use_sum += t.power_use;
                let e = per_kind.entry(format!("{:?}", b.kind)).or_insert((0, 0.0));
                e.0 += 1;
                e.1 += t.power_use;
            }
        }
    }
    println!(
        "buildings total={} by_status={:?}",
        state.buildings.len(),
        by_status
    );
    println!(
        "active power_use sum={:.1} per_kind={:?}",
        power_use_sum, per_kind
    );

    let mut sim = Simulation::new(state.width, state.height, state.seed);
    sim.load_state(state);
    for _ in 0..5 {
        sim.step(1.0 / 20.0);
    }
    println!("after 5 ticks: utilities={:?}", sim.state.utilities);
    let mut by_status2: BTreeMap<String, u32> = BTreeMap::new();
    for b in &sim.state.buildings {
        *by_status2.entry(format!("{:?}", b.status)).or_default() += 1;
    }
    println!("after 5 ticks: by_status={:?}", by_status2);
}
