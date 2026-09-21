import { AuthGate } from "@/src/components/AuthGate";
import { WrongBookList } from "@/src/components/WrongBook";

export default function WrongBookPage() {
  return <AuthGate required><WrongBookList /></AuthGate>;
}

