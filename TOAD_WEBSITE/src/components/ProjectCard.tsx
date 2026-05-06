import type { RepoData } from '../hooks/useGitHubRepos';
import './ProjectCard.css';

interface ProjectCardProps {
  repo: RepoData;
}

const ProjectCard = ({ repo }: ProjectCardProps) => {
  return (
    <div className="project-card">
      <div className="project-header">
        <h3 className="project-title">{repo.name}</h3>
        <div className="project-stars">
          <span>★</span> {repo.stargazers_count}
        </div>
      </div>
      <p className="project-description">{repo.description}</p>
      <div className="project-footer">
        <span className="project-language">{repo.language}</span>
        <a href={repo.html_url} target="_blank" rel="noopener noreferrer" className="view-link">
          View on GitHub →
        </a>
      </div>
    </div>
  );
};

export default ProjectCard;
