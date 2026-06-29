import { Suspense } from 'react';
import SetupClient from '../SetupClient';

export default function SetupFormatPage() {
  return (
    <Suspense>
      <SetupClient />
    </Suspense>
  );
}
