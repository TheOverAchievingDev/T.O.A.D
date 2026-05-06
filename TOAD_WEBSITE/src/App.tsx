import Header from './components/Header'
import Terminal from './components/Terminal'
import ProjectCard from './components/ProjectCard'
import CodeSnippet from './components/CodeSnippet'
import { useGitHubRepos } from './hooks/useGitHubRepos'
import './App.css'

function App() {
  const terminalCommands = [
    { command: 'whoami', response: 'TheOverAchievingDev' },
    { command: 'cat intro.txt', response: 'Passionate developer building high-performance web applications with clean, maintainable code.' },
    { command: 'ls services/', response: 'Fullstack_Dev  UI_UX_Design  Cloud_Architecture' },
  ];

  const { repos, loading, error } = useGitHubRepos('TheOverAchievingDev', ['T.O.A.D', 'IronCopilot']);

  const servicesCode = `interface Developer {
  name: "TheOverAchievingDev";
  services: [
    "Full-stack Web Development (React, Node.js)",
    "Scalable Cloud Architecture (AWS, Azure)",
    "UI/UX Implementation with precision",
    "API Design & Documentation"
  ];
  tools: ["TypeScript", "Vite", "Docker", "PostgreSQL"];
  availability: "Currently accepting new projects";
}`;

  return (
    <div className="app">
      <Header />
      
      <main className="main-content">
        <section className="hero">
          <div className="hero-text">
            <h1>Building elegant solutions for complex problems.</h1>
            <p>Full-stack developer specializing in React, TypeScript, and modern web architectures.</p>
          </div>
          <Terminal commands={terminalCommands} />
        </section>

        <section id="projects" className="section">
          <h2 className="section-title">Featured Projects</h2>
          <div className="projects-grid">
            {loading ? (
              <p>Loading projects...</p>
            ) : error && repos.length === 0 ? (
              <p className="error-message">{error}</p>
            ) : (
              repos.map(repo => <ProjectCard key={repo.name} repo={repo} />)
            )}
          </div>
          {error && repos.length > 0 && <p className="error-hint">Note: Some projects couldn't be loaded. They might be private or misspelled.</p>}
        </section>

        <section id="services" className="section">
          <h2 className="section-title">Professional Services</h2>
          <p>I offer a range of development services tailored to modern business needs. Here's a technical overview of my stack and offerings:</p>
          <CodeSnippet code={servicesCode} />
        </section>

        <section id="contact" className="section contact-section">
          <h2 className="section-title">Get In Touch</h2>
          <div className="contact-card">
            <p>Interested in working together? Let's talk about your next project.</p>
            <a href="mailto:contact@theoverachievingdev.com" className="contact-button">
              Send a Message
            </a>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="footer-container">
          <p>&copy; {new Date().getFullYear()} TheOverAchievingDev. Built with passion and code.</p>
        </div>
      </footer>
    </div>
  )
}

export default App
