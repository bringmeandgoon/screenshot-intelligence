export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method === 'GET') {
      return new Response(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'screenshot-intelligence',
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const requestStart = Date.now();
    const contentLength = request.headers.get('content-length') || 'unknown';
    console.log(`[API] POST /api/screenshot - content-length: ${contentLength}`);

    try {
      const body = await request.json();
      let imageBase64 = null;

      if (body.image_base64) {
        imageBase64 = cleanBase64(body.image_base64);
      } else if (body.image) {
        imageBase64 = cleanBase64(body.image);
      }

      if (!imageBase64) {
        console.log('[API] No image provided');
        return new Response(JSON.stringify({
          success: false,
          error: 'No image provided. Send JSON "image_base64" field.',
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const imageSizeKB = (imageBase64.length * 0.75) / 1024;
      console.log(`[API] Image size: ~${imageSizeKB.toFixed(0)}KB (${(imageSizeKB / 1024).toFixed(2)}MB)`);

      const intent = body.user_intent || body.intent || '记下来';
      const category = body.category || undefined;
      const todo = body.todo || undefined;
      const format = url.searchParams.get('format') || body.format || 'json';

      console.log(`[API] Processing: intent="${intent}", category="${category || '自动'}", format="${format}"`);

      const analysis = await analyzeScreenshot(imageBase64, intent, category, env);

      const noteContent = analysis.summary
        ? `${intent}${analysis.summary.replace(/。$/, '')}，${analysis.key_points.join('，')}。${todo ? '待办：' + todo + '。' : ''}`
        : intent;

      const totalElapsed = Date.now() - requestStart;
      console.log(`[API] Complete in ${totalElapsed}ms, category="${analysis.category}", summary="${analysis.summary}"`);

      if (format === 'text') {
        return new Response(noteContent, {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }

      return new Response(JSON.stringify({
        success: true,
        category: analysis.category,
        summary: analysis.summary,
        key_points: analysis.key_points,
        tags: analysis.tags,
        suggested_filename: analysis.suggested_filename,
        user_intent: intent,
        todo,
        note_content: noteContent,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (error) {
      const totalElapsed = Date.now() - requestStart;
      const errorMessage = error?.message || 'Analysis failed';
      
      console.error(`[API] Error after ${totalElapsed}ms: ${errorMessage}`);
      if (error?.status) {
        console.error(`[API] HTTP status: ${error.status}`);
      }

      const format = url.searchParams.get('format');
      if (format === 'text') {
        return new Response(`错误: ${errorMessage}`, {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }

      return new Response(JSON.stringify({
        success: false,
        error: errorMessage,
        elapsed_ms: totalElapsed,
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

function cleanBase64(data) {
  const match = data.match(/^data:image\/[^;]+;base64,(.+)$/s);
  if (match) return match[1];
  return data;
}

async function analyzeScreenshot(imageBase64, userIntent, userCategory, env) {
  const apiKey = env.OPENAI_API_KEY;
  const model = env.OPENAI_MODEL || 'gpt-4o';
  const baseUrl = env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

  if (!apiKey) throw new Error('OPENAI_API_KEY is required');

  const categories = ['穿搭', 'AI工具', '知识', '创意', '好物', '食谱', '其他'];
  const categoryList = categories.join('、');
  const prompt = `分析截图。意图:${userIntent || '记下来'} 分类:${userCategory || '自动'} 可选:${categoryList}
返回JSON:{"category":"分类","summary":"20字摘要","key_points":["要点1","要点2"],"tags":["标签1","标签2"],"suggested_filename":"文件名"}`;

  console.log(`[LLM] Calling model: ${model}, base_url: ${baseUrl}`);
  console.log(`[LLM] Image base64 length: ${imageBase64.length} chars (~${(imageBase64.length * 0.75 / 1024).toFixed(0)}KB)`);

  const startTime = Date.now();

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: `data:image/jpeg;base64,${imageBase64}`,
          },
        ],
      }],
      max_tokens: 300,
    }),
    timeout: 60000,
  });

  const elapsed = Date.now() - startTime;
  console.log(`[LLM] Response received in ${elapsed}ms`);

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[LLM] HTTP error: ${response.status} - ${errorBody}`);
    throw new Error(`LLM API error: ${response.status} - ${errorBody}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content;
  
  if (!content) throw new Error('No content returned from LLM');

  console.log(`[LLM] Raw response: ${content.slice(0, 200)}`);

  const cleaned = content.trim().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  const result = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

  return {
    category: userCategory || result.category || '其他',
    summary: result.summary || '',
    key_points: Array.isArray(result.key_points) ? result.key_points : [],
    tags: Array.isArray(result.tags) ? result.tags : [],
    suggested_filename: result.suggested_filename || `截图_${Date.now()}`,
  };
}