import { redirect } from 'next/navigation';

export default function Home() {
  // Redirect root to sign-in first, then send successful users to the investor demo.
  redirect('/sign-in?next=/index.html');
}
