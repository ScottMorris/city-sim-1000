# City Simulator Manual

## Water Network

Water is an essential utility for your city. Residential, Commercial, and Industrial zones, as well as many civic buildings, require water to function effectively.

### Production
- **Water Pumps:** Extract water from the ground. Must be placed near water sources (lakes/rivers) for maximum efficiency (planned feature). Currently, they provide a steady supply of water. Requires Power.
- **Water Towers:** Store and provide pressure. Can be placed anywhere. Do not require power, making them useful for starting a network or backup.

### Distribution
- **Pipes:** Transport water from sources to buildings.
- **Connections:** Buildings adjacent to pipes automatically connect. Water propagates through pipes and connected buildings.
- **Roads:** Roads also act as water carriers, allowing water to flow along street networks without needing separate pipes under every tile.

### Underground View
To view and manage your water network, use the **Underground View**.
- Toggle it using the layer icon on the Minimap (bottom right).
- In this view, buildings and terrain are dimmed, and pipes are clearly visible.
- **Blue Pipes/Buildings:** Connected to a water source (Wet).
- **Grey Pipes:** Not connected (Dry).

## Tools

### Water Pipe Tool
- Select the Water Pipe tool to place pipes underground.
- Cost: $5 per tile.
- Pipes can be placed under roads, buildings, or open land.
- Use the Underground View to see where you are placing them relative to your city layout.

### Inspect Tool
- Use the Inspect tool to click on any tile.
- The info panel will show the **Water** status (Wet/Dry) alongside Power and Happiness.
