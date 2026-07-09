export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import SignInClient from "./SignInClient";

export const metadata: Metadata = {
  title: "TourneyCoach — Sign in",
  description: "TourneyCoach is the AI-powered coaching platform for charity tournament organizers. The platform exists to solve one specific problem better than any incumbent: the volunteer-turnover institutional memory problem that kills most first-year charity tournaments before they reach Year 3. The mechanism is a combination of conversational AI coaching, integrated workflow software that competitors offer only as blog posts or downloadable templates, a privacy-architected player network that compounds in value with every tournament, and a patent-pending GPS data network that creates a structural moat against well-funded incumbents.",
};

export default function SignInPage() {
  return <SignInClient />;
}
