export type TickerCategory = 'utilities' | 'economy' | 'growth' | 'civic' | 'player' | 'flavour';
export type TickerSeverity = 'info' | 'warn' | 'alert';

export type SimEventType =
  | 'power_deficit_start'
  | 'power_deficit_end'
  | 'water_deficit_start'
  | 'water_deficit_end'
  | 'runway_low'
  | 'runway_recovered'
  | 'abandonment_wave'
  | 'net_flip'
  | 'player_action';

export interface SimEvent {
  id: string;
  type: SimEventType;
  timestamp: number;
  category: TickerCategory;
  severity: TickerSeverity;
  message?: string;
  data?: Record<string, unknown>;
}

export interface CitySnapshot {
  time: {
    day: number;
    month: number;
    year: number;
  };
  economy: {
    cash: number;
    netPerMonth: number;
    runwayMonths: number;
  };
  population: {
    pop: number;
    jobs: number;
    unemploymentRate: number;
    vacancyRate: number;
  };
  demand: {
    residential: number;
    commercial: number;
    industrial: number;
  };
  utilities: {
    powerProduced: number;
    powerUsed: number;
    powerBalance: number;
  };
  map: {
    abandonedCount: number;
    avgHappiness: number;
  };
}

export interface CityDeltas {
  cash: number;
  netPerMonth: number;
  runwayMonths: number;
  pop: number;
  jobs: number;
  abandonedCount: number;
  powerBalance: number;
  netPerMonthFlip?: 'positive_to_negative' | 'negative_to_positive';
}

export interface NarrativeInput {
  snapshot: CitySnapshot;
  deltas: CityDeltas;
  recentEvents: SimEvent[];
}

export interface TickerItem {
  text: string;
  category: TickerCategory;
  severity: TickerSeverity;
  expiresAt?: number;
  sourceEventType?: SimEventType;
  sourceEventId?: string;
}
