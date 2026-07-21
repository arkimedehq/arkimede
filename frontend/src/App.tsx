import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useStore } from './store/useStore';
import { useTheme } from './hooks/useTheme';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import DashboardPage from './pages/DashboardPage';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = useStore((s) => s.token);
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}

function RequireGuest({ children }: { children: React.ReactNode }) {
  const token = useStore((s) => s.token);
  return !token ? <>{children}</> : <Navigate to="/" replace />;
}

export default function App() {
  useTheme(); // initializes the theme and keeps the dark class on <html>
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<RequireGuest><LoginPage /></RequireGuest>} />
        <Route path="/register" element={<RequireGuest><RegisterPage /></RequireGuest>} />
        <Route path="/*" element={<RequireAuth><DashboardPage /></RequireAuth>} />
      </Routes>
    </BrowserRouter>
  );
}
