import { Suspense } from "react";
import { SecretsContent } from "../../../connections/_components/secrets-content";

export default function GlobalConnectionsCustomPage() {
  return (
    <Suspense>
      <SecretsContent typeFilter="generic" pageScope="organization" />
    </Suspense>
  );
}
