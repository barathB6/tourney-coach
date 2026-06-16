import { redirect } from 'next/navigation';

export default function Home() {
  // Redirect root to the static investor demo served from /public/index.html
  redirect('/index.html');
}
