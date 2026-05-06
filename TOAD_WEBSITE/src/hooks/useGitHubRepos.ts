import { useState, useEffect } from 'react';

export interface RepoData {
  name: string;
  description: string;
  html_url: string;
  stargazers_count: number;
  language: string;
  topics: string[];
}

export const useGitHubRepos = (username: string, repoNames: string[]) => {
  const [repos, setRepos] = useState<RepoData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchRepos = async () => {
      try {
        setLoading(true);
        const repoPromises = repoNames.map(name =>
          fetch(`https://api.github.com/repos/${username}/${name}`).then(res => {
            if (!res.ok) return null;
            return res.json();
          })
        );
        const results = await Promise.all(repoPromises);
        const validRepos = results.filter(repo => repo !== null) as RepoData[];
        setRepos(validRepos);
        
        if (validRepos.length === 0 && repoNames.length > 0) {
          setError('No public repositories found. Check if they are private or misspelled.');
        } else {
          setError(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        setLoading(false);
      }
    };

    fetchRepos();
  }, [username, repoNames.join(',')]);

  return { repos, loading, error };
};
