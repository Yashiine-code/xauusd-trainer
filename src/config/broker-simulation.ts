export type LeverageRule = {
  maxNotional: number | null;
  leverage: number;
};

export type BrokerSimulationConfig = {
  name: string;
  symbol: "XAUUSD";
  contractSize: number;
  minLot: number;
  lotStep: number;
  leverageRules: readonly LeverageRule[];
  marginCallLevel: number;
  stopOutLevel: number;
};

/**
 * A configurable training model inspired by high-leverage Pro accounts.
 * It is deliberately presented as a simulation, not an exact broker replica.
 */
export const BROKER_SIMULATION_CONFIG: BrokerSimulationConfig = Object.freeze({
  name: "Pro-style simulation",
  symbol: "XAUUSD",
  contractSize: 100,
  minLot: 0.01,
  lotStep: 0.01,
  leverageRules: Object.freeze([
    { maxNotional: 250_000, leverage: 2_000 },
    { maxNotional: 1_000_000, leverage: 1_000 },
    { maxNotional: null, leverage: 500 },
  ]),
  marginCallLevel: 60,
  stopOutLevel: 20,
});

