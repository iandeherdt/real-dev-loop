import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import {
  installFile,
  log,
  PACKAGE_ROOT,
  buildInstallPlan,
  listAgents,
  listSkills,
  listScripts,
} from './utils.mjs';
import { mergeLaunchJson, mergeSettingsJson, mergeClaudeMd } from './merge.mjs';
import { generateManifest } from './manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

export async function install(projectRoot, { dryRun, force, conventions }) {
  console.log('');
  const banner = `${pkg.name} v${pkg.version}`;
  console.log(banner);
  console.log('='.repeat(banner.length));
  console.log('');
  console.log(`Project: ${projectRoot}`);
  console.log('');

  const agents = listAgents();
  const skills = listSkills();
  const scripts = listScripts();
  const plan = buildInstallPlan();

  // 1. Install agents (one .md file each → .claude/agents/)
  if (agents.length > 0) {
    console.log('Installing agents...');
    for (const item of plan.filter((p) => p.dest.startsWith(join('.claude', 'agents')))) {
      installFile(
        join(PACKAGE_ROOT, item.src),
        item.dest,
        projectRoot,
        { dryRun, force }
      );
    }
    console.log('');
  }

  // 2. Install skills (each is a directory; copy file-by-file so partial
  //    skills with user customisations in templates/ still merge cleanly).
  if (skills.length > 0) {
    console.log('Installing skills...');
    for (const item of plan.filter((p) => p.dest.startsWith(join('.claude', 'skills')))) {
      installFile(
        join(PACKAGE_ROOT, item.src),
        item.dest,
        projectRoot,
        { dryRun, force }
      );
    }
    console.log('');
  }

  // 3. Install pipeline scripts
  if (scripts.length > 0) {
    console.log('Installing scripts...');
    for (const item of plan.filter((p) => p.dest.startsWith(join('.claude', 'scripts')))) {
      installFile(
        join(PACKAGE_ROOT, item.src),
        item.dest,
        projectRoot,
        { dryRun, force }
      );
    }
    console.log('');
  }

  // 3b. Install reference docs (progressive-disclosure companions that agent
  //     files link to instead of inlining). They land under
  //     `.claude/specsmith/`, not `.claude/agents/`, so Claude Code does not
  //     try to load them as subagent definitions.
  const references = plan.filter((p) =>
    p.dest.startsWith(join('.claude', 'specsmith', 'references'))
  );
  if (references.length > 0) {
    console.log('Installing references...');
    for (const item of references) {
      installFile(join(PACKAGE_ROOT, item.src), item.dest, projectRoot, { dryRun, force });
    }
    console.log('');
  }

  // 4. Configure project — launch.json (merge), settings.json (merge), CLAUDE.md (append)
  console.log('Configuring project...');
  const launchSrc = join(PACKAGE_ROOT, 'launch.json');
  if (existsSync(launchSrc)) {
    mergeLaunchJson(projectRoot, launchSrc, { dryRun, force });
  }
  mergeSettingsJson(projectRoot, { dryRun, force });
  const claudeMdSrc = join(PACKAGE_ROOT, 'templates', 'claude-md-section.md');
  if (existsSync(claudeMdSrc)) {
    mergeClaudeMd(projectRoot, claudeMdSrc, { dryRun });
  }
  console.log('');

  // 5. Install constitution starter at .claude/constitution.md
  //    Never overwrite an existing one (it's user content) unless --force.
  console.log('Installing constitution...');
  installFile(
    join(PACKAGE_ROOT, 'templates', 'constitution.md'),
    join('.claude', 'constitution.md'),
    projectRoot,
    { dryRun, force }
  );
  console.log('');

  // 5a. Install glossary starter at specs/glossary.md — the project's
  //     ubiquitous language. Like the constitution it is user/AI-owned
  //     content: seeded once, never overwritten (except --force), and NOT
  //     tracked in the manifest, so `update` leaves it alone. /grill-me
  //     reads it and appends canonical terms over time.
  console.log('Installing glossary...');
  installFile(
    join(PACKAGE_ROOT, 'templates', 'glossary.md'),
    join('specs', 'glossary.md'),
    projectRoot,
    { dryRun, force }
  );
  console.log('');

  // 5b. Install conventions starter at .claude/conventions.json — opt-in
  //     via --conventions flag. The check-conventions.mjs script ships
  //     either way and no-ops when no conventions.json exists, so users
  //     can enable conventions later by adding the file by hand.
  if (conventions) {
    console.log('Installing conventions starter...');
    installFile(
      join(PACKAGE_ROOT, 'templates', 'conventions.json'),
      join('.claude', 'conventions.json'),
      projectRoot,
      { dryRun, force }
    );
    console.log('');
  }

  // 6. Wire Playwright MCP (used by evaluator and design-critique for browser testing)
  console.log('Configuring MCP servers...');
  if (dryRun) {
    log.dry('claude mcp add playwright (project scope)');
  } else {
    try {
      const result = execSync('claude mcp list 2>&1', { cwd: projectRoot, encoding: 'utf8' });
      if (result.includes('playwright')) {
        log.skip('Playwright MCP already configured');
      } else {
        execSync(
          'claude mcp add --scope project playwright -- npx @playwright/mcp@latest --isolated',
          { cwd: projectRoot, stdio: 'pipe' }
        );
        log.success('Added Playwright MCP server (project scope)');
      }
    } catch (err) {
      log.warn('Could not add Playwright MCP via the `claude` CLI.');
      log.warn('Either install Claude Code (https://claude.com/code) and re-run init,');
      log.warn('or add this entry to .mcp.json at the project root manually:');
      log.warn('');
      log.warn('  {');
      log.warn('    "mcpServers": {');
      log.warn('      "playwright": {');
      log.warn('        "command": "npx",');
      log.warn('        "args": ["-y", "@playwright/mcp@latest", "--isolated"]');
      log.warn('      }');
      log.warn('    }');
      log.warn('  }');
    }
  }
  console.log('');

  // 7. Create runtime output directories and seed procedures cache
  if (dryRun) {
    log.dry('pipeline/feedback/ (output directory)');
    log.dry('pipeline/traces/ (output directory)');
    log.dry('pipeline/procedures.md (seeded cache)');
  } else {
    mkdirSync(join(projectRoot, 'pipeline', 'feedback'), { recursive: true });
    log.success('pipeline/feedback/ (output directory)');
    mkdirSync(join(projectRoot, 'pipeline', 'traces'), { recursive: true });
    log.success('pipeline/traces/ (output directory)');
    seedProceduresMd(projectRoot);
  }
  console.log('');

  // 8. Generate manifest
  console.log('Generating manifest...');
  generateManifest(projectRoot, { dryRun });
  console.log('');

  if (dryRun) {
    console.log('Dry run complete. No files were modified.');
  } else {
    console.log('Installation complete.');
    console.log('');
    console.log('Next steps:');
    console.log('  1. Edit `.claude/constitution.md` to capture this project\'s principles');
    if (conventions) {
      console.log('  2. Edit `.claude/conventions.json` to fit this project\'s code conventions');
      console.log('  3. Start a new feature:    /grill-me  →  /write-prd  →  /plan  →  /tasks');
      console.log('  4. Pressure-test a plan:   /grill-plan');
      console.log('  5. Run the build loop:     /build');
      console.log('  6. Run the design loop:    /design');
    } else {
      console.log('  2. Start a new feature:    /grill-me  →  /write-prd  →  /plan  →  /tasks');
      console.log('  3. Pressure-test a plan:   /grill-plan');
      console.log('  4. Run the build loop:     /build');
      console.log('  5. Run the design loop:    /design');
      console.log('');
      console.log('  Optional: re-run with --conventions to drop a starter .claude/conventions.json');
      console.log('  for machine-checkable per-project rules (Tailwind enforcement, SVG extraction,');
      console.log('  data-access patterns). The check-conventions script is already installed and');
      console.log('  no-ops until you add the file.');
    }
  }
}

/**
 * Seed pipeline/procedures.md if missing; otherwise append the overlay
 * meta-procedure if not already present. Existing user-written content is
 * never overwritten.
 */
function seedProceduresMd(projectRoot) {
  const proceduresPath = join(projectRoot, 'pipeline', 'procedures.md');
  const overlay = OVERLAY_META_PROCEDURE;

  if (!existsSync(proceduresPath)) {
    writeFileSync(proceduresPath, PROCEDURES_HEADER + overlay);
    log.success('pipeline/procedures.md (seeded with overlay meta-procedure)');
    return;
  }

  const existing = readFileSync(proceduresPath, 'utf8');
  if (existing.includes('## Overlays blocking forms')) {
    log.skip('pipeline/procedures.md (already seeded)');
    return;
  }
  writeFileSync(proceduresPath, existing.trimEnd() + '\n' + overlay);
  log.success('pipeline/procedures.md (preserved existing; appended overlay meta-procedure)');
}

const PROCEDURES_HEADER = `# Procedures

Multi-step UI flows (login, logout, etc.) discovered by the evaluator and
design-critique subagents. Each procedure has a \`## <name>\` heading;
subagents grep by name before executing a flow that might already be
documented:

\`\`\`bash
grep -A 30 '^## Login' pipeline/procedures.md
\`\`\`

If the procedure exists, follow it. If not, discover the flow and append a
new \`## <name>\` section before completing your task.

---

`;

const OVERLAY_META_PROCEDURE = `## Overlays blocking forms

**When to use**: any time you're about to interact with a form (login,
signup, booking, search, etc.) on a page you haven't verified is
overlay-free.

**Symptom if you skip this**: you fill credentials, click submit, and
either (a) nothing happens, (b) the page rerenders and your field values
clear, or (c) you land back on the same form. Cookie consent banners,
GDPR notices, age gates, push-notification prompts, and modal popups all
do this.

**Steps**:
1. Take \`mcp__playwright__browser_snapshot\` BEFORE any form interaction.
   Look at the *whole* element tree, not just the form.
2. Scan the snapshot for buttons whose text matches (case-insensitive):
   \`accept\`, \`reject\`, \`allow\`, \`deny\`, \`got it\`, \`ok\`,
   \`i agree\`, \`continue\`, \`dismiss\`, \`close\`, \`cookie\`,
   \`privacy\`. Buttons near the top/bottom of the page or in a floating
   container are usually overlay controls.
3. Click the most permissive accept button. (For consent banners:
   "Accept All" > "Accept" > "Got it" > "OK". Avoid "Manage preferences"
   or "Reject All" — they may load a settings dialog.)
4. Take a fresh snapshot. The overlay should be gone.
5. NOW fill and submit the form.

**Per-project**: once you've discovered the actual button text and
selector for this site, append a site-specific procedure (e.g.
\`## Cookie consent dismissal\`) with the exact element references so
future cycles skip the snapshot-and-scan step.
`;
