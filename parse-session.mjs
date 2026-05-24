#!/usr/bin/env node
import init from "sql.js";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const DB_PATH =
  process.env.OPENCODE_DB_PATH ||
  path.join(
    process.env.USERPROFILE || process.env.HOME,
    ".local",
    "share",
    "opencode",
    "opencode.db"
  );

function parseRows(result) {
  if (!result || !result.length || !result[0].values) return [];
  const cols = result[0].columns;
  return result[0].values.map((row) => {
    const obj = {};
    cols.forEach((c, i) => (obj[c] = row[i]));
    return obj;
  });
}

function getModelDisplayName(modelId) {
  if (!modelId) return null;
  return modelId.split("/").pop();
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function tryGitDiffNumstat(oldRef, newRef, workDir) {
  try {
    const out = execSync(
      `git diff-tree --numstat -r ${oldRef} ${newRef}`,
      { cwd: workDir, encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }
    );
    return out.trim();
  } catch {}
  try {
    const out = execSync(
      `git diff --numstat ${oldRef} ${newRef}`,
      { cwd: workDir, encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }
    );
    return out.trim();
  } catch {}
  return null;
}

function parseNumstat(output, workDir) {
  const changes = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addStr, delStr, filePath] = parts;
    if (!filePath) continue;
    const additions = addStr === "-" ? 0 : parseInt(addStr, 10) || 0;
    const deletions = delStr === "-" ? 0 : parseInt(delStr, 10) || 0;
    let type = "modified";
    if (additions > 0 && deletions === 0) type = "added";
    else if (additions === 0 && deletions > 0) type = "deleted";
    let clean = filePath.replace(/^"?(.+)"?$/, "$1");
    const rel = path.relative(workDir, clean).replace(/\\/g, "/");
    if (rel.startsWith("node_modules")) continue;
    changes.push({ path: rel, type, additions, deletions });
  }
  return changes;
}

function buildChangesFromEdits(parsedParts, workDir) {
  const fileStats = new Map();
  const writePaths = new Set();

  for (const pp of parsedParts) {
    if (pp.parsed.type !== "tool") continue;
    const tool = pp.parsed.tool;
    const input = pp.parsed.state?.input;
    if (!input) continue;

    if (tool === "edit" && input.filePath) {
      const rel = path.relative(workDir, input.filePath).replace(/\\/g, "/");
      if (rel.startsWith("node_modules")) continue;
      if (!fileStats.has(rel)) fileStats.set(rel, { additions: 0, deletions: 0, hasOld: false, hasNew: false });
      const st = fileStats.get(rel);
      const oldLines = (input.oldString || "").split("\n").length;
      const newLines = (input.newString || "").split("\n").length;
      st.additions += newLines;
      st.deletions += oldLines;
      st.hasOld = st.hasOld || input.oldString?.length > 0;
      st.hasNew = st.hasNew || input.newString?.length > 0;
    }

    if (tool === "write" && input.filePath) {
      const rel = path.relative(workDir, input.filePath).replace(/\\/g, "/");
      if (rel.startsWith("node_modules")) continue;
      writePaths.add(rel);
      if (!fileStats.has(rel)) fileStats.set(rel, { additions: 0, deletions: 0, hasOld: false, hasNew: false });
      const st = fileStats.get(rel);
      const lines = (input.content || "").split("\n").length;
      st.additions += lines;
      st.hasNew = true;
    }
  }

  return [...fileStats.entries()].map(([filePath, st]) => {
    let type = "modified";
    if (!st.hasOld && st.hasNew) type = "added";
    else if (st.hasOld && !st.hasNew) type = "deleted";
    else if (writePaths.has(filePath) && !st.hasOld) type = "added";
    return { path: filePath, type, additions: st.additions, deletions: st.deletions };
  });
}

function normalizePath(p) {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

function buildChangesFromPatches(session, patches) {
  const allFiles = new Map();
  for (const p of patches) {
    if (!p.files) continue;
    for (const f of p.files) {
      const rel = path.relative(session.directory, f).replace(/\\/g, "/");
      if (rel.startsWith("node_modules")) continue;
      if (!allFiles.has(rel)) allFiles.set(rel, { additions: 0, deletions: 0 });
    }
  }
  const totalFiles = allFiles.size || session.summary_files || 1;
  const avgAdd = Math.round((session.summary_additions || 0) / totalFiles);
  const avgDel = Math.round((session.summary_deletions || 0) / totalFiles);
  if (allFiles.size === 0) {
    if (session.summary_files > 0) {
      return [
        {
          path: "(unknown)",
          type: "modified",
          additions: session.summary_additions || 0,
          deletions: session.summary_deletions || 0,
        },
      ];
    }
    return [];
  }
  return [...allFiles.entries()].map(([filePath]) => ({
    path: filePath,
    type: avgAdd > 0 && avgDel === 0 ? "added" : avgAdd === 0 && avgDel > 0 ? "deleted" : "modified",
    additions: avgAdd,
    deletions: avgDel,
  }));
}

async function getSessionInfo(sessionId) {
  const SQL = await init();
  const buf = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buf);

  try {
    const sessionRows = parseRows(
      db.exec(`SELECT * FROM session WHERE id = '${sessionId}'`)
    );
    if (!sessionRows.length) {
      throw new Error(`Session "${sessionId}" not found`);
    }
    const session = sessionRows[0];

    const messages = parseRows(
      db.exec(
        `SELECT id, time_created, data FROM message WHERE session_id = '${sessionId}' ORDER BY time_created`
      )
    );

    const parts = parseRows(
      db.exec(
        `SELECT id, message_id, time_created, data FROM part WHERE session_id = '${sessionId}' ORDER BY time_created`
      )
    );

    const parsedParts = parts.map((p) => ({
      ...p,
      parsed: JSON.parse(p.data),
    }));

    let tokensIn = 0;
    let tokensOut = 0;
    let totalTokens = 0;
    let costUSD = 0;
    let modelId = null;
    let startTime = null;
    let endTime = null;
    let lastAssistantText = null;

    for (const msg of messages) {
      const d = JSON.parse(msg.data);
      if (d.role === "assistant") {
        tokensIn += d.tokens?.input || 0;
        tokensOut += d.tokens?.output || 0;
        totalTokens += (d.tokens?.input || 0) + (d.tokens?.output || 0);
        costUSD += d.cost || 0;
        if (!modelId && d.modelID) modelId = d.modelID;
        if (d.time?.completed) {
          if (!endTime || d.time.completed > endTime) endTime = d.time.completed;
        }
      }
      if (d.time?.created) {
        if (!startTime || d.time.created < startTime) startTime = d.time.created;
      }
    }

    for (let i = parsedParts.length - 1; i >= 0; i--) {
      const pp = parsedParts[i];
      if (pp.parsed.type === "text") {
        const parentMsg = messages.find((m) => m.id === pp.message_id);
        if (parentMsg) {
          const md = JSON.parse(parentMsg.data);
          if (md.role === "assistant") {
            lastAssistantText = pp.parsed.text;
            break;
          }
        }
      }
    }

    const durationMs =
      endTime && startTime
        ? endTime - startTime
        : session.time_updated - session.time_created;

    const modelRaw = session.model ? JSON.parse(session.model).id : modelId;
    const modelName = getModelDisplayName(modelRaw);

    const date = new Date(session.time_created).toISOString();
    const durationMin = Math.ceil(durationMs / 60000);
    const gitDiffUrl = session.share_url || null;

    const patches = parsedParts.filter((p) => p.parsed.type === "patch").map((p) => p.parsed);

    const stepStarts = parsedParts
      .filter((p) => p.parsed.type === "step-start" && p.parsed.snapshot)
      .map((p) => p.parsed.snapshot);

    const stepFinishes = parsedParts
      .filter((p) => p.parsed.type === "step-finish" && p.parsed.snapshot)
      .map((p) => p.parsed.snapshot);

    let changes = [];
    const workDir = session.directory;

    if (workDir && fs.existsSync(path.join(workDir, ".git"))) {
      const initialSnapshot = stepStarts[0] || null;
      const finalSnapshot = stepFinishes[stepFinishes.length - 1] || null;

      if (initialSnapshot && finalSnapshot && initialSnapshot !== finalSnapshot) {
        const diffOut = tryGitDiffNumstat(initialSnapshot, finalSnapshot, workDir);
        if (diffOut) {
          changes = parseNumstat(diffOut, workDir);
        }
      }

      if (changes.length === 0 && initialSnapshot) {
        const diffOut = tryGitDiffNumstat(initialSnapshot, "HEAD", workDir);
        if (diffOut) {
          changes = parseNumstat(diffOut, workDir);
        }
      }

      if (changes.length === 0 && finalSnapshot) {
        try {
          const headTree = execSync("git rev-parse HEAD^{tree}", {
            cwd: workDir,
            encoding: "utf-8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();
          if (headTree !== finalSnapshot) {
            const diffOut = tryGitDiffNumstat(finalSnapshot, headTree, workDir);
            if (diffOut) changes = parseNumstat(diffOut, workDir);
          }
        } catch {}
      }

      if (changes.length === 0 && patches.length > 0) {
        const patchFiles = new Set();
        for (const p of patches) {
          if (!p.files) continue;
          for (const f of p.files) {
            const rel = path.relative(workDir, f).replace(/\\/g, "/");
            if (!rel.startsWith("node_modules")) patchFiles.add(rel);
          }
        }
        if (patchFiles.size > 0) {
          try {
            const diffOut = execSync(
              `git diff --numstat HEAD -- ${[...patchFiles].map((f) => `"${f}"`).join(" ")}`,
              { cwd: workDir, encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }
            ).trim();
            if (diffOut) {
              changes = parseNumstat(diffOut, workDir);
            }
          } catch {}
        }
      }
    }

    if (changes.length === 0 && parsedParts.length > 0) {
      changes = buildChangesFromEdits(parsedParts, workDir);
    }

    if (changes.length === 0) {
      changes = buildChangesFromPatches(session, patches);
    }

    const summary = session.title || "";

    return {
      model: modelName,
      summary,
      date,
      duration: formatDuration(durationMs),
      durationMinutes: durationMin,
      tokensIn,
      tokensOut,
      totalTokens,
      costUSD: Math.round(costUSD * 1000000) / 1000000,
      gitDiffUrl,
      changes,
    };
  } finally {
    db.close();
  }
}

async function listSessions(limit = 20) {
  const SQL = await init();
  const buf = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buf);
  try {
    const rows = parseRows(
      db.exec(
        `SELECT id, title, time_created FROM session ORDER BY time_updated DESC LIMIT ${limit}`
      )
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      date: new Date(r.time_created).toISOString(),
    }));
  } finally {
    db.close();
  }
}

async function findSessionsByDirectory(cwd) {
  const SQL = await init();
  const buf = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buf);
  try {
    const rows = parseRows(
      db.exec(
        `SELECT id, directory, title, time_created, parent_id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC`
      )
    );
    const normCwd = normalizePath(cwd);
    return rows.filter((r) => {
      const normDir = normalizePath(r.directory);
      return normDir === normCwd || normCwd.startsWith(normDir + "/");
    });
  } finally {
    db.close();
  }
}

async function exportProjectSessions(agent) {
  const cwd = process.cwd();
  const sessions = await findSessionsByDirectory(cwd);

  if (sessions.length === 0) {
    console.log(`No sessions found for directory: ${cwd}`);
    process.exit(0);
  }

  const exportDir = path.join(cwd, `export-${agent}`);
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

  console.log(`Found ${sessions.length} session(s) for: ${cwd}\n`);

  for (const s of sessions) {
    try {
      const info = await getSessionInfo(s.id);
      const outPath = path.join(exportDir, `${s.id}.json`);
      fs.writeFileSync(outPath, JSON.stringify(info, null, 2), "utf-8");
      console.log(`  ${s.id}  ${s.title || "(untitled)"}  ->  export-${agent}/${s.id}.json`);
    } catch (err) {
      console.error(`  ${s.id}  ERROR: ${err.message}`);
    }
  }

  console.log(`\nExported to: ${exportDir}`);
}

const SUPPORTED_AGENTS = ["opencode"];

const args = process.argv.slice(2);
let agent = null;
let sessionId = null;
let showList = false;

for (const arg of args) {
  if (arg === "--list" || arg === "-l") {
    showList = true;
  } else if (arg.startsWith("--db-path=")) {
    process.env.OPENCODE_DB_PATH = arg.split("=").slice(1).join("=");
  } else if (arg.startsWith("--agent=")) {
    agent = arg.split("=")[1];
  } else if (arg.startsWith("ses_")) {
    sessionId = arg;
  } else if (SUPPORTED_AGENTS.includes(arg)) {
    agent = arg;
  }
}

if (showList) {
  const sessions = await listSessions();
  console.log("Recent sessions:");
  for (const s of sessions) {
    console.log(`  ${s.id}  ${s.title}  (${s.date})`);
  }
  process.exit(0);
}

if (sessionId) {
  const info = await getSessionInfo(sessionId);
  const exportsDir = path.join(process.cwd(), "exports");
  if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });
  const outPath = path.join(exportsDir, `${sessionId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(info, null, 2), "utf-8");
  console.log(`Saved: ${outPath}`);
  process.exit(0);
}

const agents = agent ? [agent] : SUPPORTED_AGENTS;
for (const a of agents) {
  const cwdSessions = await findSessionsByDirectory(process.cwd());
  if (cwdSessions.length === 0) {
    console.log(`No ${a} sessions found for: ${process.cwd()}`);
    continue;
  }
  await exportProjectSessions(a);
}
