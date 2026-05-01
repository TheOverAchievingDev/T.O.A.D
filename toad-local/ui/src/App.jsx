import Dashboard from './components/Dashboard';
import { Terminal, Settings, LayoutDashboard, Users } from 'lucide-react';
import './App.css';

function App() {
  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="logo-icon">
            <Terminal size={24} />
          </div>
          <div>
            <h1 style={{ fontSize: '1.25rem', margin: 0, fontWeight: 700 }}>TOAD</h1>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Local Orchestrator
            </span>
          </div>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <button className="btn" style={{ justifyContent: 'flex-start', padding: '0.75rem 1rem', background: 'rgba(255,255,255,0.05)', color: '#fff', borderLeft: '3px solid var(--primary-color)', borderRadius: '0 var(--radius-sm) var(--radius-sm) 0' }}>
            <LayoutDashboard size={18} />
            Dashboard
          </button>
          <button className="btn" style={{ justifyContent: 'flex-start', padding: '0.75rem 1rem', color: 'var(--text-secondary)' }}>
            <Users size={18} />
            Teams
          </button>
          <button className="btn" style={{ justifyContent: 'flex-start', padding: '0.75rem 1rem', color: 'var(--text-secondary)' }}>
            <Settings size={18} />
            Configuration
          </button>
        </nav>

        <div style={{ marginTop: 'auto', padding: '1rem', background: 'var(--bg-color)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
          <div className="stat-label" style={{ marginBottom: '0.5rem' }}>Core Version</div>
          <div className="flex items-center justify-between">
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.875rem' }}>v0.1.0-alpha</span>
            <span className="badge badge-success" style={{ fontSize: '0.65rem' }}>STABLE</span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <header className="topbar">
          <div>
            <h2 style={{ fontSize: '1.5rem', margin: 0 }}>System Overview</h2>
            <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.875rem' }}>Real-time telemetry and orchestrator health.</p>
          </div>
          <div className="flex gap-4">
            <button className="btn btn-secondary">
              View Logs
            </button>
            <button className="btn btn-primary">
              Launch Agent
            </button>
          </div>
        </header>

        <Dashboard />
      </main>
    </div>
  );
}

export default App;
