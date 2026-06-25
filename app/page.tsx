import { redirect } from 'next/navigation';

export default function Home() {
  // Redirect root to the investor demo
  redirect('/index.html');
}
