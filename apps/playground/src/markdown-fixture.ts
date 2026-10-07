export const markdownPreview = `# Project guide

Read and edit project documentation without leaving the workspace.

**Markdown** supports _formatted text_, ~~old instructions~~, and inline \`code\`.

[Architecture](architecture.md) · [Jump to checklist](#release-checklist)

## Development

1. Open a project.
2. Review the changes.
3. Save your documentation.

> Keep the source and rendered document side by side while writing.

\`\`\`typescript
interface Project {
  name: string;
  ready: boolean;
}

const project: Project = { name: "Example", ready: true };
\`\`\`

## View modes

| Mode | Use it for |
| --- | --- |
| Code | Editing Markdown source |
| Split | Writing with a live preview |
| Preview | Reading the finished document |

## Local illustration

![Project illustration](preview-image.svg)

## Release checklist

- [x] Review the documentation
- [ ] Update the examples
- [ ] Publish the release

Return to the [project guide](#project-guide).
`;

let holdImages = false;
const pendingImages = new Set<() => void>();
/** Only the browser sample exposes controllable reads for lifecycle regressions. */
export const markdownImageReads = {
  hold() { holdImages = true; },
  pending() { return pendingImages.size; },
  release() {
    holdImages = false;
    for (const resolve of pendingImages) resolve();
    pendingImages.clear();
  },
};
export async function waitForMarkdownImages(): Promise<void> {
  if (holdImages) await new Promise<void>(resolve => pendingImages.add(resolve));
}
