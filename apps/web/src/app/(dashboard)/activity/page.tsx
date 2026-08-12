import type { Metadata } from "next";
import { ActivityContent } from "./_components/activity-content";

export const metadata: Metadata = {
  title: "Activity",
};

export default function ActivityPage() {
  return <ActivityContent />;
}
