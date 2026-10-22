/**
 * src/App.jsx — Root Application component
 * Provides AuthContext, SseContext, and React Router routes.
 */

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { SseProvider } from './context/SseContext.jsx';
import LoginPage from './components/LoginPage.jsx';
import Layout from './components/Layout.jsx';

import LiveFeed from './pages/LiveFeed.jsx';
import Quarantine from './pages/Quarantine.jsx';
import Proposals from './pages/Proposals.jsx';
import Schemas from './pages/Schemas.jsx';
import Sources from './pages/Sources.jsx';
import Status from './pages/Status.jsx';
import Simulator from './pages/Simulator.jsx';

function AuthenticatedApp() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <SseProvider>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<LiveFeed />} />
          <Route path="quarantine" element={<Quarantine />} />
          <Route path="proposals" element={<Proposals />} />
          <Route path="schemas" element={<Schemas />} />
          <Route path="sources" element={<Sources />} />
          <Route path="status" element={<Status />} />
          <Route path="simulator" element={<Simulator />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </SseProvider>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AuthenticatedApp />
      </BrowserRouter>
    </AuthProvider>
  );
}
