import { TrainerApp } from "@/src/components/TrainerApp";
import { AuthGate } from "@/src/components/AuthGate";
import { usesPersistentProductState } from "@/src/server/market-data";
import { phase2Enabled } from "@/src/server/phase2-config";

export default function Home() {
  const persistent = phase2Enabled() && usesPersistentProductState();
  return <AuthGate required={persistent}><TrainerApp persistenceEnabled={persistent} /></AuthGate>;
}
