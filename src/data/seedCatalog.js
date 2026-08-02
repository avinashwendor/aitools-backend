/**
 * Curated catalog for `npm run seed`.
 * Logos use Google's favicon CDN so images stay reliable in production.
 */

import slugify from 'slugify';
import { extraTools } from './catalogExpansion.js';

export const logo = domain =>
  `https://www.google.com/s2/favicons?sz=128&domain_url=https://${domain}`;

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export const categories = [
  { name: 'Writing', slug: 'writing', icon: '✍️', color: '#3b82f6', description: 'AI writing, editing, and content creation', order: 1 },
  { name: 'Image', slug: 'image', icon: '🖼️', color: '#8b5cf6', description: 'Image generation and editing', order: 2 },
  { name: 'Video', slug: 'video', icon: '🎬', color: '#06b6d4', description: 'Video creation and editing', order: 3 },
  { name: 'Audio', slug: 'audio', icon: '🎵', color: '#10b981', description: 'Voice, music, and audio production', order: 4 },
  { name: 'Coding', slug: 'coding', icon: '💻', color: '#f59e0b', description: 'Code assistants and developer tools', order: 5 },
  { name: 'Productivity', slug: 'productivity', icon: '⚡', color: '#6366f1', description: 'Workflow automation and productivity', order: 6 },
  { name: 'Marketing', slug: 'marketing', icon: '📈', color: '#ec4899', description: 'Marketing, ads, and growth', order: 7 },
  { name: 'Research', slug: 'research', icon: '🔬', color: '#14b8a6', description: 'Research and knowledge discovery', order: 8 },
  { name: 'Design', slug: 'design', icon: '🎨', color: '#a855f7', description: 'UI/UX and visual design', order: 9 },
  { name: 'Business', slug: 'business', icon: '💼', color: '#f97316', description: 'Operations, sales, and HR', order: 10 },
  { name: 'Education', slug: 'education', icon: '📚', color: '#22c55e', description: 'Learning and teaching', order: 11 },
  { name: 'Data & Analytics', slug: 'data', icon: '📊', color: '#0ea5e9', description: 'Data analysis and dashboards', order: 12 },
  { name: 'Customer Support', slug: 'support', icon: '💬', color: '#f43f5e', description: 'Support desks and chatbots', order: 13 },
  { name: 'HR & Recruiting', slug: 'hr', icon: '👥', color: '#8b5cf6', description: 'Hiring and career tools', order: 14 },
  { name: 'Legal', slug: 'legal', icon: '⚖️', color: '#64748b', description: 'Legal research and contracts', order: 15 },
  { name: 'Finance', slug: 'finance', icon: '💰', color: '#22c55e', description: 'Finance and accounting', order: 16 },
  { name: 'Social Media', slug: 'social', icon: '📱', color: '#3b82f6', description: 'Social content and scheduling', order: 19 },
  { name: 'Other', slug: 'other', icon: '🔧', color: '#64748b', description: 'Other AI utilities', order: 100 },
];

/** Flagship tools — names, copy, and metrics tuned for a real directory feel. */
export const coreTools = [
  {
    name: 'ChatGPT',
    tagline: 'General-purpose AI assistant for writing, coding, and analysis',
    description:
      'ChatGPT helps you draft content, debug code, brainstorm ideas, and work through complex problems in natural language. The Plus tier adds faster models, image input, and custom GPTs.',
    domain: 'chat.openai.com',
    screenshot: '/images/featured/chatgpt.png',
    websiteUrl: 'https://chat.openai.com',
    category: 'writing',
    pricing: 'freemium',
    pricingDetails: 'Free tier available. Plus $20/month',
    features: ['Conversational AI', 'Code help', 'Document upload', 'Image understanding', 'Custom GPTs'],
    tags: ['chatbot', 'writing', 'coding', 'assistant', 'openai'],
    views: 420000, likes: 18200, rating: 4.8, reviewCount: 4200, isFeatured: true, isVerified: true,
  },
  {
    name: 'Claude',
    tagline: 'Thoughtful AI assistant with a large context window',
    description:
      'Claude from Anthropic is strong at long documents, careful reasoning, coding, and structured writing. Projects let you attach files and instructions that persist across chats.',
    domain: 'claude.ai',
    screenshot: '/images/featured/claude.webp',
    websiteUrl: 'https://claude.ai',
    category: 'writing',
    pricing: 'freemium',
    pricingDetails: 'Free tier available. Pro $20/month',
    features: ['200K+ token context', 'Projects', 'Artifacts', 'Code analysis', 'Document Q&A'],
    tags: ['chatbot', 'writing', 'research', 'anthropic', 'assistant'],
    views: 310000, likes: 14100, rating: 4.7, reviewCount: 2800, isFeatured: true, isVerified: true,
  },
  {
    name: 'Google Gemini',
    tagline: 'Multimodal AI deeply integrated with Google Workspace',
    description:
      'Gemini answers questions, summarizes Gmail and Docs, generates images, and helps with coding. Advanced tier unlocks the strongest models and deeper Workspace integration.',
    domain: 'gemini.google.com',
    websiteUrl: 'https://gemini.google.com',
    category: 'writing',
    pricing: 'freemium',
    pricingDetails: 'Free tier. Advanced from $19.99/month',
    features: ['Multimodal chat', 'Workspace integration', 'Image generation', 'Long context', 'Mobile app'],
    tags: ['google', 'assistant', 'multimodal', 'workspace'],
    views: 280000, likes: 11800, rating: 4.6, reviewCount: 2400, isFeatured: true, isVerified: true,
  },
  {
    name: 'Perplexity',
    tagline: 'Answer engine with live web search and citations',
    description:
      'Perplexity combines search and chat: you get a direct answer with linked sources, useful for research, competitive analysis, and fact-checking before you publish.',
    domain: 'perplexity.ai',
    websiteUrl: 'https://perplexity.ai',
    category: 'research',
    pricing: 'freemium',
    pricingDetails: 'Free searches daily. Pro $20/month',
    features: ['Cited answers', 'Focus modes', 'File upload', 'Collections', 'API access'],
    tags: ['search', 'research', 'citations', 'answers'],
    views: 195000, likes: 8200, rating: 4.6, reviewCount: 1600, isFeatured: true, isVerified: true,
  },
  {
    name: 'Cursor',
    tagline: 'AI-native code editor for shipping faster',
    description:
      'Cursor is a VS Code fork built around AI: chat with your repo, edit multiple files from a prompt, and run agentic refactors with full codebase context.',
    domain: 'cursor.com',
    websiteUrl: 'https://cursor.com',
    category: 'coding',
    pricing: 'freemium',
    pricingDetails: 'Hobby free. Pro $20/month',
    features: ['Repo-aware chat', 'Multi-file edits', 'Tab completion', 'Agent mode', 'MCP integrations'],
    tags: ['ide', 'coding', 'developer', 'agent'],
    views: 240000, likes: 11200, rating: 4.8, reviewCount: 2100, isFeatured: true, isVerified: true,
  },
  {
    name: 'GitHub Copilot',
    tagline: 'AI pair programmer inside your IDE',
    description:
      'Copilot suggests whole lines and functions as you type, reviews pull requests, and answers questions about your repository from VS Code, JetBrains, and Neovim.',
    domain: 'github.com',
    websiteUrl: 'https://github.com/features/copilot',
    category: 'coding',
    pricing: 'paid',
    pricingDetails: 'Individual $10/month. Business $19/user/month',
    features: ['Inline completion', 'Chat in IDE', 'PR summaries', 'CLI agent', 'Policy controls'],
    tags: ['github', 'coding', 'autocomplete', 'enterprise'],
    views: 360000, likes: 14800, rating: 4.6, reviewCount: 3200, isFeatured: true, isVerified: true,
  },
  {
    name: 'Midjourney',
    tagline: 'High-quality artistic image generation from text',
    description:
      'Midjourney produces stylized, production-ready images from prompts. Popular for concept art, marketing visuals, and rapid creative exploration via Discord or the web app.',
    domain: 'midjourney.com',
    screenshot: '/images/featured/midjourney.jpg',
    websiteUrl: 'https://midjourney.com',
    category: 'image',
    pricing: 'paid',
    pricingDetails: 'Plans from $10/month',
    features: ['Text to image', 'Style tuning', 'Upscaling', 'Variations', 'Pan and zoom'],
    tags: ['image generation', 'art', 'design', 'creative'],
    views: 390000, likes: 16500, rating: 4.9, reviewCount: 3800, isFeatured: true, isVerified: true,
  },
  {
    name: 'DALL-E 3',
    tagline: 'OpenAI image model with strong prompt adherence',
    description:
      'DALL-E 3 generates detailed images from natural language and is available in ChatGPT and via API. Good for marketing assets, storyboards, and quick visual concepts.',
    domain: 'openai.com',
    screenshot: '/images/featured/dalle-3.png',
    websiteUrl: 'https://openai.com/dall-e-3',
    category: 'image',
    pricing: 'paid',
    pricingDetails: 'Included with ChatGPT Plus or pay-per-use API',
    features: ['Text to image', 'Inpainting', 'Style control', 'Safety filters', 'API'],
    tags: ['image generation', 'openai', 'marketing', 'creative'],
    views: 220000, likes: 9400, rating: 4.7, reviewCount: 1900, isFeatured: true, isVerified: true,
  },
  {
    name: 'Runway',
    tagline: 'Generative video tools for creators and teams',
    description:
      'Runway Gen models turn text or images into video clips, remove backgrounds, and add motion to stills — a common finishing step in short-form and ad workflows.',
    domain: 'runwayml.com',
    websiteUrl: 'https://runwayml.com',
    category: 'video',
    pricing: 'freemium',
    pricingDetails: 'Free credits monthly. Standard from $15/month',
    features: ['Text to video', 'Image to video', 'Motion brush', 'Green screen', 'Lip sync'],
    tags: ['video generation', 'editing', 'creative', 'ads'],
    views: 175000, likes: 7200, rating: 4.5, reviewCount: 1400, isFeatured: true, isVerified: true,
  },
  {
    name: 'Notion AI',
    tagline: 'AI writing and Q&A inside your Notion workspace',
    description:
      'Notion AI summarizes pages, drafts docs, extracts action items, and answers questions across your connected workspace — useful when your team already lives in Notion.',
    domain: 'notion.so',
    websiteUrl: 'https://notion.so/product/ai',
    category: 'productivity',
    pricing: 'paid',
    pricingDetails: '$10/member/month add-on',
    features: ['Summaries', 'Draft generation', 'Q&A over workspace', 'Translations', 'Action items'],
    tags: ['notes', 'wiki', 'team', 'writing', 'productivity'],
    views: 210000, likes: 8600, rating: 4.5, reviewCount: 1700, isFeatured: true, isVerified: true,
  },
  {
    name: 'Zapier',
    tagline: 'Connect apps and automate workflows with AI',
    description:
      'Zapier links thousands of SaaS tools and now builds automations from plain English. Common glue for CRM updates, lead routing, and content pipelines.',
    domain: 'zapier.com',
    websiteUrl: 'https://zapier.com',
    category: 'productivity',
    pricing: 'freemium',
    pricingDetails: 'Free for 100 tasks/month. Professional from $19.99/month',
    features: ['Zaps', 'AI actions', 'Tables', 'Interfaces', 'Enterprise SSO'],
    tags: ['automation', 'integration', 'no-code', 'workflow'],
    views: 260000, likes: 9800, rating: 4.5, reviewCount: 2200, isFeatured: false, isVerified: true,
  },
  {
    name: 'Jasper',
    tagline: 'Marketing copilot for campaigns and brand voice',
    description:
      'Jasper helps marketing teams produce on-brand blog posts, ads, emails, and social copy with templates, campaign workflows, and team governance.',
    domain: 'jasper.ai',
    websiteUrl: 'https://jasper.ai',
    category: 'marketing',
    pricing: 'paid',
    pricingDetails: 'Creator from $49/month',
    features: ['Brand voice', 'Campaigns', 'Templates', 'SEO mode', 'Team workspaces'],
    tags: ['marketing', 'copywriting', 'content', 'brand'],
    views: 140000, likes: 5100, rating: 4.3, reviewCount: 980, isFeatured: false, isVerified: true,
  },
  {
    name: 'Grammarly',
    tagline: 'AI writing assistant for clarity and tone',
    description:
      'Grammarly checks grammar, suggests clearer phrasing, adjusts tone, and now drafts full replies — widely used for email, docs, and support teams.',
    domain: 'grammarly.com',
    websiteUrl: 'https://grammarly.com',
    category: 'writing',
    pricing: 'freemium',
    pricingDetails: 'Free basics. Premium from $12/month',
    features: ['Grammar check', 'Tone rewrite', 'Plagiarism detection', 'Browser extension', 'Generative drafts'],
    tags: ['writing', 'editing', 'email', 'productivity'],
    views: 320000, likes: 12400, rating: 4.6, reviewCount: 4100, isFeatured: false, isVerified: true,
  },
  {
    name: 'Gamma',
    tagline: 'Generate decks, docs, and webpages from a prompt',
    description:
      'Gamma turns an outline into a polished presentation or microsite with layouts, images, and speaker notes — faster than rebuilding slides from scratch.',
    domain: 'gamma.app',
    websiteUrl: 'https://gamma.app',
    category: 'productivity',
    pricing: 'freemium',
    pricingDetails: 'Free credits. Plus from $10/month',
    features: ['AI decks', 'Web pages', 'Templates', 'Export to PDF/PPT', 'Collaboration'],
    tags: ['presentations', 'slides', 'docs', 'pitch'],
    views: 125000, likes: 5400, rating: 4.6, reviewCount: 890, isFeatured: true, isVerified: true,
  },
  {
    name: 'Otter.ai',
    tagline: 'Meeting transcription and AI summaries',
    description:
      'Otter joins Zoom, Meet, and Teams calls to transcribe in real time, highlight decisions, and share searchable notes with your team.',
    domain: 'otter.ai',
    websiteUrl: 'https://otter.ai',
    category: 'productivity',
    pricing: 'freemium',
    pricingDetails: '300 minutes/month free. Pro $16.99/month',
    features: ['Live transcription', 'Summaries', 'Speaker ID', 'Integrations', 'OtterPilot for email'],
    tags: ['meetings', 'transcription', 'notes', 'sales'],
    views: 155000, likes: 6100, rating: 4.4, reviewCount: 1100, isFeatured: false, isVerified: true,
  },
];

export const seedUsers = [
  {
    name: 'Admin',
    email: 'admin@aitools.com',
    password: 'admin123',
    role: 'admin',
    avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=admin',
  },
  {
    name: 'Test User',
    email: 'user@example.com',
    password: 'user123',
    role: 'user',
    avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=testuser',
  },
];

/** Realistic reviews tied to tool names after seed. */
export const seedComments = [
  {
    toolName: 'ChatGPT',
    rating: 5,
    content: 'I use this daily for drafting emails, outlining blog posts, and debugging small scripts. The free tier is enough to evaluate; Plus is worth it if you live in it.',
  },
  {
    toolName: 'ChatGPT',
    rating: 4,
    content: 'Great general assistant, but I still double-check facts on anything customer-facing. For brainstorming and first drafts it saves hours.',
  },
  {
    toolName: 'Claude',
    rating: 5,
    content: 'Best experience I have had uploading long PDFs and asking follow-up questions. The writing tone is noticeably more natural than other chatbots.',
  },
  {
    toolName: 'Cursor',
    rating: 5,
    content: 'Switched from vanilla VS Code and never looked back. Repo-wide edits and the agent mode cut our feature turnaround time roughly in half.',
  },
  {
    toolName: 'Midjourney',
    rating: 5,
    content: 'Still the most consistent aesthetic quality for marketing visuals. Learning prompt structure takes a weekend; output quality is unmatched for our brand work.',
  },
  {
    toolName: 'Perplexity',
    rating: 4,
    content: 'My go-to for research before writing. Citations make it easy to verify claims, which matters when publishing technical content.',
  },
];

function normalizeTool(raw) {
  const domain = raw.domain || domainFromUrl(raw.websiteUrl);
  const { domain: _drop, ...rest } = raw;
  return {
    ...rest,
    logo: raw.logo || (domain ? logo(domain) : null),
    screenshot: raw.screenshot || null,
  };
}

/** Merge core catalog with expansion set, deduped by slug. */
export function buildToolCatalog() {
  const merged = new Map();

  for (const tool of [...coreTools, ...extraTools]) {
    const normalized = normalizeTool(tool);
    const slug = slugify(normalized.name, { lower: true, strict: true });
    if (!merged.has(slug)) merged.set(slug, normalized);
  }

  return [...merged.values()];
}
