import { AuthGate } from "@/src/components/AuthGate";
import { WrongBookDetail } from "@/src/components/WrongBook";

export default async function WrongBookDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AuthGate required><WrongBookDetail id={id} /></AuthGate>;
}
