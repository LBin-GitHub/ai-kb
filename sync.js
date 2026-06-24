#!/usr/bin/env node
/**
 * Feishu AI Knowledge Base Sync Script
 * 
 * Pulls content from Feishu wiki, processes bidirectional links,
 * generates graph data, and outputs structured JSON.
 * 
 * Usage: node sync.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LARK_CLI = '/Users/mac/.workbuddy/binaries/node/cli-connector-packages/bin/lark-cli';
const SPACE_ID = '7652314514440031192';
const OUTPUT_DIR = path.join(__dirname, 'docs', 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'kb-data.json');

// Run lark-cli command
function lark(cmd) {
  const fullCmd = `${LARK_CLI} ${cmd} 2>&1`;
  try {
    const raw = execSync(fullCmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    // Handle output that may have prefix text before JSON
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const jsonStr = raw.substring(jsonStart, jsonEnd + 1);
      try { return JSON.parse(jsonStr); } catch {}
    }
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Command failed: ${cmd.split(' ').slice(0, 4).join(' ')}...`);
    console.error(e.message);
    return null;
  }
}

// Fetch all wiki nodes recursively
function getAllNodes(parentNodeToken = '') {
  let cmd = `wiki +node-list --space-id ${SPACE_ID} --as user --format json`;
  if (parentNodeToken) {
    cmd += ` --parent-node-token "${parentNodeToken}"`;
  }
  const result = lark(cmd);
  if (!result || !result.ok || !result.data) return [];
  
  const nodes = (result.data.nodes || []).map(n => ({
    node_token: n.node_token,
    obj_token: n.obj_token,
    obj_type: n.obj_type,
    title: n.title || '未命名文档',
    parent_node_token: n.parent_node_token || '',
    has_child: n.has_child || false,
  }));

  // Recursively fetch children
  let allNodes = [...nodes];
  for (const node of nodes) {
    if (node.has_child) {
      allNodes = allNodes.concat(getAllNodes(node.node_token));
    }
  }
  return allNodes;
}

// Fetch document content
function fetchDocContent(objToken) {
  // Try markdown format
  let result = lark(`docs +fetch --api-version v2 --doc "${objToken}" --doc-format markdown --as user`);
  if (!result || !result.ok) {
    // Fallback to XML
    result = lark(`docs +fetch --api-version v2 --doc "${objToken}" --doc-format xml --as user`);
  }
  if (!result || !result.ok) return '';

  if (result.data && result.data.document) {
    return result.data.document.content || '';
  }
  return '';
}

// Convert XML content to clean text
function cleanContent(content, format) {
  if (!content) return '';
  if (format === 'markdown') {
    // Already markdown format
    return content;
  }
  // Strip XML tags for plain text representation
  return content
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

// Extract wiki-style links [[...]] from content
function extractLinks(content) {
  const links = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim());
  }
  return [...new Set(links)];
}

// Extract hashtags from content
function extractTags(content) {
  const tags = new Set();
  // Match #中文标签 or #english-tag patterns
  const regex = /#[\u4e00-\u9fff\w\u00C0-\u024F-]+/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const tag = match[0].substring(1);
    if (tag.length > 1 && tag.length < 30) {
      tags.add(tag);
    }
  }
  return [...tags];
}

// Generate a summary from content
function generateSummary(content, maxLen = 120) {
  const clean = content.replace(/[#*_`\[\]\(\)>]+/g, '').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen).replace(/\s+\S*$/, '') + '...';
}

// Main sync function
async function main() {
  console.log('🔄 Syncing from Feishu AI Knowledge Base...\n');

  // 1. Get all nodes
  console.log('📂 Fetching wiki structure...');
  const allNodes = getAllNodes();
  console.log(`   Found ${allNodes.length} documents\n`);

  // 2. Build tree structure
  const rootNodes = allNodes.filter(n => !n.parent_node_token);
  
  // 3. Fetch content for each document
  const documents = [];
  for (const node of allNodes) {
    if (!node.title || node.title === '未命名文档') continue;
    if (!node.obj_token) continue;

    console.log(`📄 Fetching: ${node.title}`);
    const rawContent = fetchDocContent(node.obj_token);
    const content = cleanContent(rawContent, 'markdown');
    
    if (!content || content === node.title) continue; // Skip empty docs

    documents.push({
      id: node.obj_token,
      nodeToken: node.node_token,
      title: node.title,
      content: content,
      summary: generateSummary(content),
      tags: extractTags(content),
      links: extractLinks(content),
      parentToken: node.parent_node_token || null,
    });
  }

  // 4. Resolve bidirectional links
  console.log('\n🔗 Resolving bidirectional links...');
  const titleToId = {};
  for (const doc of documents) {
    titleToId[doc.title] = doc.id;
    // Also index by key phrases from the title
    const shortTitle = doc.title.split(/[：:|：/·]+/).pop()?.trim();
    if (shortTitle && shortTitle !== doc.title) {
      titleToId[shortTitle] = doc.id;
    }
  }

  // Build graph edges
  const edges = [];
  const edgeSet = new Set();

  // Build nodeToken → doc.id map for parent-child resolution
  const nodeTokenToId = {};
  for (const doc of documents) {
    if (doc.nodeToken) nodeTokenToId[doc.nodeToken] = doc.id;
  }

  // Edges from wiki tree: parent ↔ child
  for (const doc of documents) {
    if (doc.parentToken) {
      const parentId = nodeTokenToId[doc.parentToken];
      if (parentId && parentId !== doc.id) {
        const edgeKey = [doc.id, parentId].sort().join('|');
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          edges.push({ source: doc.id, target: parentId });
        }
      }
    }
  }

  // Edges from explicit [[links]] in content
  for (const doc of documents) {
    for (const link of doc.links) {
      const targetId = titleToId[link];
      if (targetId && targetId !== doc.id) {
        const edgeKey = [doc.id, targetId].sort().join('|');
        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey);
          edges.push({ source: doc.id, target: targetId });
        }
      }
    }
    // Auto-link based on title mentions in content
    for (const other of documents) {
      if (other.id === doc.id) continue;
      // Try full title, short title, and cleaned title (no brackets)
      const cleanedTitle = other.title.replace(/[（(][^)）]*[)）]/g, '').trim();
      const shortTitle = other.title.split(/[：:|：/·]+/).pop()?.trim();
      const candidates = [other.title, ...(shortTitle && shortTitle !== other.title ? [shortTitle] : []), ...(cleanedTitle && cleanedTitle !== other.title && cleanedTitle !== shortTitle ? [cleanedTitle] : [])];
      for (const candidate of candidates) {
        if (candidate && candidate.length >= 3 && doc.content.includes(candidate)) {
          const edgeKey = [doc.id, other.id].sort().join('|');
          if (!edgeSet.has(edgeKey)) {
            edgeSet.add(edgeKey);
            edges.push({ source: doc.id, target: other.id, autoDetected: true });
          }
          break; // one match is enough
        }
      }
    }
  }

  // 5. Build graph nodes
  const graph = {
    nodes: documents.map(d => ({
      id: d.id,
      title: d.title,
      tags: d.tags,
      // Determine node importance by connections
      weight: 1,
    })),
    edges: edges,
  };

  // Calculate node weights
  const connectionCount = {};
  for (const edge of edges) {
    connectionCount[edge.source] = (connectionCount[edge.source] || 0) + 1;
    connectionCount[edge.target] = (connectionCount[edge.target] || 0) + 1;
  }
  for (const node of graph.nodes) {
    node.weight = Math.min(5, Math.max(1, Math.log2((connectionCount[node.id] || 0) + 1) + 1));
  }

  // 6. Build output
  const output = {
    generated: new Date().toISOString(),
    spaceId: SPACE_ID,
    tree: buildTree(documents),
    documents: documents.map(d => ({
      id: d.id,
      title: d.title,
      summary: d.summary,
      content: d.content,
      tags: d.tags,
      parentToken: d.parentToken,
    })),
    graph: graph,
    backlinks: buildBacklinks(documents, edges),
  };

  // 7. Write output
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
  
  console.log(`\n✅ Sync complete!`);
  console.log(`   - ${allNodes.length} total nodes in wiki`);
  console.log(`   - ${documents.length} documents with content`);
  console.log(`   - ${edges.length} edges in graph`);
  console.log(`   - Output: ${OUTPUT_FILE}`);
  console.log(`   - Size: ${(fs.statSync(OUTPUT_FILE).size / 1024).toFixed(1)} KB`);
}

function buildTree(documents) {
  const childrenMap = {};
  for (const doc of documents) {
    if (doc.parentToken) {
      if (!childrenMap[doc.parentToken]) childrenMap[doc.parentToken] = [];
      childrenMap[doc.parentToken].push(doc.id);
    }
  }
  
  const roots = documents.filter(d => !d.parentToken);
  
  function toTree(doc) {
    return {
      id: doc.id,
      title: doc.title,
      children: (childrenMap[doc.nodeToken] || []).map(childId => {
        const child = documents.find(d => d.id === childId);
        return child ? toTree(child) : null;
      }).filter(Boolean),
    };
  }
  
  return roots.map(toTree);
}

function buildBacklinks(documents, edges) {
  const backlinks = {};
  for (const doc of documents) {
    backlinks[doc.id] = [];
  }
  for (const edge of edges) {
    backlinks[edge.target] = backlinks[edge.target] || [];
    const source = documents.find(d => d.id === edge.source);
    if (source) {
      backlinks[edge.target].push({
        id: source.id,
        title: source.title,
        autoDetected: edge.autoDetected || false,
      });
    }
    // Also add reverse
    backlinks[edge.source] = backlinks[edge.source] || [];
    const target = documents.find(d => d.id === edge.target);
    if (target) {
      backlinks[edge.source].push({
        id: target.id,
        title: target.title,
        autoDetected: edge.autoDetected || false,
      });
    }
  }
  return backlinks;
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
