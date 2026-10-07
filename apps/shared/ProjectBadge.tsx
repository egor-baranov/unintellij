import './ProjectBadge.css';

const badgeColors = ['#8da65b', '#e5825d', '#b58a0b', '#a45bdb', '#4c8bd0', '#41988e'];

/** Rendered locally from project identity, shared by the launcher and picker. */
export function ProjectBadge({ project }: { project: { name: string; path: string } }) {
  const words = project.name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const initials = Array.from(words.slice(0, 2).map(word => Array.from(word)[0]).join('').toLocaleUpperCase()).slice(0, 2).join('') || '?';
  // The same directory keeps its color when its session ID changes.
  let hash = 0;
  for (const character of project.path) hash = (Math.imul(hash, 31) + character.codePointAt(0)!) >>> 0;
  return <span className="project-badge" style={{ backgroundColor: badgeColors[hash % badgeColors.length] }} aria-hidden="true">{initials}</span>;
}
