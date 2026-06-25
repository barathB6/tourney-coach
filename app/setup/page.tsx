import { Suspense } from 'react';
import SetupClient from './SetupClient';

export default function SetupPage() {
  return (
    <Suspense>
      <SetupClient />
    </Suspense>
  );
}
