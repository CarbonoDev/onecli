import { Suspense } from "react";
import { SecretsContent } from "../../../connections/_components/secrets-content";

export default function GlobalConnectionsLlmsPage() {
  return (
    <Suspense>
      <SecretsContent typeFilter="llm" pageScope="organization" />
    </Suspense>
  );
}
