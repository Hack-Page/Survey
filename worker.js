/**
 * Cloudflare Worker Backend for Leggett & Platt Survey Platform
 * Kết nối Serverless PostgreSQL trên Neon (neon.tech) qua native HTTP API (Zero dependencies)
 */

let tablesInitialized = false;

function getNeonHost(dbUrl) {
  try {
    const u = new URL(dbUrl);
    return u.hostname;
  } catch (e) {
    const m = (dbUrl || '').match(/@([^/:]+)/);
    return m ? m[1] : '';
  }
}

function getClientIP(request) {
  const h = request.headers;
  const cfIp = (h.get('CF-Connecting-IP') || h.get('True-Client-IP') || '').trim();
  if (cfIp) return cfIp;
  return (h.get('X-Real-IP') || '').trim();
}

function getAdminCredentials(env) {
  return {
    user: (env.ADMIN_USER || env.ADMIN_USERNAME || 'admin').trim(),
    pass: (env.ADMIN_PASS || env.ADMIN_PASSWORD || 'admin123').trim()
  };
}

function isAdminAuthorized(request, env) {
  const creds = getAdminCredentials(env);
  const headerKey = (request.headers.get('x-admin-key') || request.headers.get('X-Admin-Key') || '').trim();
  const authHeader = (request.headers.get('Authorization') || '').trim();
  let token = headerKey;
  if (!token && authHeader.toLowerCase().startsWith('bearer ')) token = authHeader.slice(7).trim();
  return token === creds.pass;
}

// === HỖ TRỢ ẢNH ĐÍNH KÈM (R2 binding IMAGES_BUCKET) ===
const IMAGE_KEY_RE = /^img\/[A-Za-z0-9._-]+$/;

function extractImageKeys(answers) {
  let list = answers;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
  if (!Array.isArray(list)) return [];
  const keys = [];
  for (const a of list) {
    if (a && Array.isArray(a.images)) {
      for (const k of a.images) {
        if (typeof k === 'string' && IMAGE_KEY_RE.test(k)) keys.push(k);
      }
    }
  }
  return keys;
}

// Thu thập key ảnh từ các bài nộp khớp điều kiện WHERE (trước khi xóa để dọn R2)
async function collectImageKeys(dbUrl, whereSql, params = []) {
  try {
    const rows = await queryNeon(dbUrl, `SELECT answers FROM responses WHERE ${whereSql};`, params);
    const list = Array.isArray(rows) ? rows : (rows && rows.rows ? rows.rows : []);
    const keys = [];
    for (const r of list) keys.push(...extractImageKeys(r.answers));
    return keys;
  } catch (e) {
    console.warn('Collect image keys warning:', e.message);
    return [];
  }
}

async function deleteImageKeys(env, keys) {
  const uniq = Array.from(new Set(keys || []));
  if (!uniq.length || !env.IMAGES_BUCKET) return;
  try { await env.IMAGES_BUCKET.delete(uniq); } catch (e) { console.warn('R2 image cleanup warning:', e.message); }
}

async function queryNeon(dbUrl, sql, params = []) {
  const host = getNeonHost(dbUrl);
  if (!host) throw new Error('DATABASE_URL không hợp lệ, không thể trích xuất host Neon');

  const endpoint = `https://${host}/sql`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Neon-Connection-String': dbUrl,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql, params })
  });

  if (!response.ok) {
    const errText = await response.text();
    let errMsg = errText;
    try {
      const errJson = JSON.parse(errText);
      if (errJson.message) errMsg = errJson.message;
    } catch (e) {}
    throw new Error(`Neon DB Error (${response.status}): ${errMsg}`);
  }

  const data = await response.json();
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rows)) return data.rows;
  return data;
}

async function ensureTables(dbUrl) {
  if (tablesInitialized) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS surveys (
      id VARCHAR(64) PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      questions JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `CREATE TABLE IF NOT EXISTS responses (
      id SERIAL PRIMARY KEY,
      survey_id VARCHAR(64) NOT NULL,
      employee_msnv VARCHAR(64) NOT NULL,
      employee_name VARCHAR(255) NOT NULL,
      employee_dept VARCHAR(255) NOT NULL,
      answers JSONB NOT NULL,
      submitted_at TIMESTAMPTZ DEFAULT NOW()
    );`,
    `ALTER TABLE responses ADD COLUMN IF NOT EXISTS client_ip VARCHAR(64);`,
    `ALTER TABLE responses ADD COLUMN IF NOT EXISTS survey_title TEXT;`,
    `CREATE INDEX IF NOT EXISTS idx_resp_survey ON responses(survey_id);`,
    `CREATE INDEX IF NOT EXISTS idx_resp_msnv ON responses(employee_msnv);`,
    `CREATE INDEX IF NOT EXISTS idx_resp_ip ON responses(client_ip);`,
    `DROP INDEX IF EXISTS idx_resp_survey_ip_unique;`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_resp_survey_msnv_unique ON responses(survey_id, employee_msnv) WHERE employee_msnv IS NOT NULL AND employee_msnv <> '';`
  ];

  for (const stmt of statements) {
    try {
      await queryNeon(dbUrl, stmt);
    } catch (e) {
      console.warn('Table init warning:', e.message);
    }
  }
  tablesInitialized = true;
}

export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key, X-Admin-Key, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const DB_URL = env.DATABASE_URL;

    // Admin login không cần DB
    if (path === '/api/admin/login' && request.method === 'POST') {
      try {
        const body = await request.json().catch(()=>({}));
        const username = (body.username || body.user || '').trim();
        const password = (body.password || body.pass || '').trim();
        const creds = getAdminCredentials(env);
        if (username === creds.user && password === creds.pass) {
          return new Response(JSON.stringify({ success: true, message: 'Login success', user: creds.user }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } else {
          return new Response(JSON.stringify({ success: false, error: 'Sai tài khoản hoặc mật khẩu' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      } catch(e){ return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders }); }
    }

    if (!DB_URL) {
      return new Response(
        JSON.stringify({ error: 'Chưa cấu hình biến DATABASE_URL trong Cloudflare Worker!' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    try {
      // 1. Kiểm tra trạng thái hoạt động (Health check)
      if (path === '/' || path === '/api/health') {
        let dbOk = false;
        let dbError = null;
        try {
          await queryNeon(DB_URL, 'SELECT 1 as ok');
          dbOk = true;
        } catch (e) {
          dbError = e.message;
        }
        return new Response(JSON.stringify({
          status: 'ok',
          service: 'Leggett Survey Worker',
          neonConfigured: true,
          dbOk,
          dbError
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Storage: GET /api/storage
      if (path === '/api/storage' && request.method === 'GET') {
        if (!isAdminAuthorized(request, env)) return new Response(JSON.stringify({ error: 'Unauthorized'}),{status:401,headers:{...corsHeaders,'Content-Type':'application/json'}});
        try {
          const rows = await queryNeon(DB_URL, `SELECT pg_database_size(current_database())::bigint as size`);
          const size = Number(rows[0]?.size || rows[0]?.pg_database_size || 0);
          const limit = 536870912;
          const percent = Math.min(100, (size/limit)*100);
          const pretty = (size/1024/1024).toFixed(2)+' MB / 512 MB';
          return new Response(JSON.stringify({ size, limit, percent: Number(percent.toFixed(2)), pretty }), { headers:{...corsHeaders,'Content-Type':'application/json'}});
        } catch(e){ return new Response(JSON.stringify({ error:e.message }),{status:500,headers:{...corsHeaders,'Content-Type':'application/json'}}); }
      }

      // Đảm bảo các bảng surveys và responses đã được tạo trong Neon
      await ensureTables(DB_URL);

      // 1b. UPLOAD ẢNH ĐÍNH KÈM: POST /api/images  (public – người tham gia nộp, nén sẵn phía client)
      if (path === '/api/images' && request.method === 'POST') {
        if (!env.IMAGES_BUCKET) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Chưa cấu hình R2 binding IMAGES_BUCKET (tạo bucket "imagesurvey" và khai báo binding)'
          }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const body = await request.json().catch(() => null);
        if (!body || !body.data) {
          return new Response(JSON.stringify({ success: false, error: 'Thiếu dữ liệu ảnh (data base64)' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const contentType = String(body.contentType || 'image/jpeg').toLowerCase();
        if (!/^image\/(jpeg|jpg|png|webp|gif|bmp)$/.test(contentType)) {
          return new Response(JSON.stringify({ success: false, error: 'Định dạng ảnh không hợp lệ' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const b64 = String(body.data).replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
          return new Response(JSON.stringify({ success: false, error: 'Base64 ảnh không hợp lệ' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const approxBytes = Math.floor(b64.length * 3 / 4);
        if (approxBytes > 5 * 1024 * 1024) {
          return new Response(JSON.stringify({ success: false, error: 'Ảnh vượt quá 5MB sau nén' }), { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        let bytes;
        try {
          const bin = atob(b64);
          bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: 'Không giải mã được ảnh' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const extMap = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };
        const ext = extMap[contentType] || 'jpg';
        const key = 'img/' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10) + '.' + ext;
        try {
          await env.IMAGES_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: 'Lưu ảnh lên R2 thất bại: ' + e.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ success: true, key }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // 1c. LẤY ẢNH: GET /api/images/<key>  – CHỈ ADMIN (x-admin-key), người tham gia không xem được qua link
      if (path.startsWith('/api/images/') && request.method === 'GET') {
        if (!isAdminAuthorized(request, env)) {
          return new Response(JSON.stringify({ error: 'Unauthorized - cần đăng nhập admin' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (!env.IMAGES_BUCKET) {
          return new Response(JSON.stringify({ error: 'Chưa cấu hình R2 binding IMAGES_BUCKET' }), { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const key = decodeURIComponent(path.slice('/api/images/'.length));
        if (!IMAGE_KEY_RE.test(key)) {
          return new Response(JSON.stringify({ error: 'Key ảnh không hợp lệ' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const obj = await env.IMAGES_BUCKET.get(key);
        if (!obj) {
          return new Response(JSON.stringify({ error: 'Ảnh không tồn tại' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const headers = new Headers(corsHeaders);
        headers.set('Content-Type', (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg');
        headers.set('Cache-Control', 'private, max-age=3600');
        return new Response(obj.body, { headers });
      }

        // CHECK đã nộp chưa: Chỉ kiểm tra khi có msnv (Mã Số Nhân Viên).
        // TUYỆT ĐỐI KHÔNG kiểm tra trùng theo IP đơn thuần, tránh chặn nhầm khi nhiều máy dùng chung wifi/4G.
        if (path === '/api/responses/check' && request.method === 'GET') {
          const surveyId = url.searchParams.get('survey_id') || url.searchParams.get('surveyId') || url.searchParams.get('id');
          const msnvRaw = (url.searchParams.get('msnv') || url.searchParams.get('employee_msnv') || '').trim();
          const msnv = msnvRaw.toUpperCase();
          const clientIp = getClientIP(request);
          if (!surveyId) return new Response(JSON.stringify({ error: 'survey_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

          if (!msnv) {
            return new Response(JSON.stringify({ submitted: false, client_ip: clientIp }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }

          const rows = await queryNeon(DB_URL, `SELECT id, survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at, client_ip FROM responses WHERE survey_id = $1 AND UPPER(employee_msnv) = $2 LIMIT 1;`, [surveyId, msnv]);
          const rowsList = Array.isArray(rows) ? rows : (rows && rows.rows ? rows.rows : []);
          if (rowsList.length > 0) {
            const r = rowsList[0];
            let parsedAnswers = r.answers;
            if (typeof parsedAnswers === 'string') { try{parsedAnswers=JSON.parse(parsedAnswers);}catch(e){parsedAnswers=[];} }
            return new Response(JSON.stringify({ submitted: true, reason: 'msnv', client_ip: clientIp, response: {...r, answers: parsedAnswers||[]} }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          } else {
            return new Response(JSON.stringify({ submitted: false, client_ip: clientIp }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
        }

        // 2. Nộp bài khảo sát từ người làm (Submit Response) – chặn trùng theo MSNV
        if (path === '/api/responses' && request.method === 'POST') {
          const body = await request.json();
          const {
            survey_id,
            employee_msnv,
            employee_name,
            employee_dept,
            answers,
            submitted_at
          } = body;

          const clientIp = getClientIP(request);
          const msnvTrimRaw = (employee_msnv||'').trim();
          const msnvTrim = msnvTrimRaw.toUpperCase();
          const sid = survey_id || 'DEFAULT';

          if (msnvTrim && !/^LEP[A-Z0-9]+$/.test(msnvTrim)) {
            return new Response(JSON.stringify({ success:false, error:'MSNV phải bắt đầu bằng "LEP" và sau LEP chỉ chứa chữ/số (ví dụ: LEP123, LEPA12). Bạn đã nhập: '+msnvTrimRaw }), { status:400, headers:{...corsHeaders,'Content-Type':'application/json'}});
          }

          if (sid && msnvTrim) {
            const dupRows = await queryNeon(DB_URL, `SELECT id FROM responses WHERE survey_id=$1 AND UPPER(employee_msnv)=$2 LIMIT 1;`, [sid, msnvTrim]);
            const dupList = Array.isArray(dupRows)?dupRows:(dupRows&&dupRows.rows?dupRows.rows:[]);
            if (dupList.length>0) return new Response(JSON.stringify({ success:false, error:'Mã số nhân viên (' + msnvTrim + ') đã nộp bài khảo sát này rồi. Mỗi nhân viên chỉ được tham gia 1 lần. Nếu muốn làm lại hãy liên hệ nhân sự.' }), { status:409, headers:{...corsHeaders,'Content-Type':'application/json'}});
          }

          const answersStr = typeof answers === 'string' ? answers : JSON.stringify(answers || []);
          try {
            const result = await queryNeon(
              DB_URL,
              `INSERT INTO responses (survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at, client_ip)
               VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
               RETURNING id;`,
              [
                sid,
                msnvTrim || '',
                employee_name || '',
                employee_dept || '',
                answersStr,
                submitted_at || new Date().toISOString(),
                clientIp || ''
              ]
            );
            const insertedId = (Array.isArray(result) && result.length > 0) ? (result[0].id || result[0]) : result;
            return new Response(JSON.stringify({ success: true, id: insertedId, client_ip: clientIp }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          } catch(e){
            if (e.message && (e.message.includes('duplicate')||e.message.includes('unique')||e.message.includes('idx_resp_'))) {
              return new Response(JSON.stringify({ success:false, error:'Mã số nhân viên (' + msnvTrim + ') đã nộp bài khảo sát này rồi. Vui lòng liên hệ nhân sự nếu muốn làm lại.' }), { status:409, headers:{...corsHeaders,'Content-Type':'application/json'}});
            }
            throw e;
          }
        }

      // 3. Lấy danh sách kết quả phản hồi cho Admin (Get Responses) - yêu cầu admin
      if (path === '/api/responses' && request.method === 'GET') {
        if (!isAdminAuthorized(request, env)) return new Response(JSON.stringify({ error:'Unauthorized - cần đăng nhập admin'}),{status:401,headers:{...corsHeaders,'Content-Type':'application/json'}});
        const surveyId = url.searchParams.get('survey_id');
        let rows;
        if (surveyId) {
          rows = await queryNeon(
            DB_URL,
            `SELECT id, survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at, client_ip
             FROM responses WHERE survey_id = $1 ORDER BY submitted_at DESC LIMIT 10000;`,
            [surveyId]
          );
        } else {
          rows = await queryNeon(
            DB_URL,
            `SELECT id, survey_id, employee_msnv, employee_name, employee_dept, answers, submitted_at, client_ip
             FROM responses ORDER BY submitted_at DESC LIMIT 10000;`
          );
        }

        const rowsList = Array.isArray(rows) ? rows : (rows && rows.rows ? rows.rows : []);

        const normalizedRows = rowsList.map(r => {
          let parsedAnswers = r.answers;
          if (typeof parsedAnswers === 'string') {
            try { parsedAnswers = JSON.parse(parsedAnswers); } catch (e) { parsedAnswers = []; }
          }
          return {
            ...r,
            answers: parsedAnswers || []
          };
        });

        return new Response(JSON.stringify(normalizedRows), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 4. XÓA DỮ LIỆU: DELETE /api/responses?id=... hoặc ids=... hoặc truncate
      if (path === '/api/responses' && request.method === 'DELETE') {
        if (!isAdminAuthorized(request, env)) return new Response(JSON.stringify({ error:'Unauthorized - cần đăng nhập admin'}),{status:401,headers:{...corsHeaders,'Content-Type':'application/json'}});
        const id = url.searchParams.get('id');
        const ids = url.searchParams.get('ids');
        const surveyId = url.searchParams.get('survey_id');
        const msnv = url.searchParams.get('msnv')||url.searchParams.get('employee_msnv');
        const ip = url.searchParams.get('ip')||url.searchParams.get('client_ip');
        // Thu thập key ảnh R2 TRƯỚC khi xóa bài để dọn ảnh đính kèm (tránh rác R2)
        let imageKeys = [];
        if (ids) {
          var idList = ids.split(',').map(function(s){return s.trim();}).filter(Boolean);
          for (var k=0;k<idList.length;k++) {
            imageKeys.push(...await collectImageKeys(DB_URL, 'id = $1', [idList[k]]));
          }
          for (var k=0;k<idList.length;k++) {
            await queryNeon(DB_URL, `DELETE FROM responses WHERE id = $1;`, [idList[k]]);
          }
          await deleteImageKeys(env, imageKeys);
          return new Response(JSON.stringify({ success: true, message: 'Đã xóa '+idList.length+' bài nộp', ids: idList }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        if (id) {
          imageKeys = await collectImageKeys(DB_URL, 'id = $1', [id]);
          await queryNeon(DB_URL, `DELETE FROM responses WHERE id=$1;`,[id]);
          await deleteImageKeys(env, imageKeys);
          return new Response(JSON.stringify({success:true,message:'Đã xóa bài nộp id='+id}),{headers:{...corsHeaders,'Content-Type':'application/json'}});
        }
        if (surveyId && msnv) {
          imageKeys = await collectImageKeys(DB_URL, 'survey_id = $1 AND employee_msnv = $2', [surveyId, msnv]);
          await queryNeon(DB_URL, `DELETE FROM responses WHERE survey_id=$1 AND employee_msnv=$2;`,[surveyId,msnv]);
          await deleteImageKeys(env, imageKeys);
          return new Response(JSON.stringify({success:true}),{headers:{...corsHeaders,'Content-Type':'application/json'}});
        }
        if (surveyId && ip) {
          imageKeys = await collectImageKeys(DB_URL, 'survey_id = $1 AND client_ip = $2', [surveyId, ip]);
          await queryNeon(DB_URL, `DELETE FROM responses WHERE survey_id=$1 AND client_ip=$2;`,[surveyId,ip]);
          await deleteImageKeys(env, imageKeys);
          return new Response(JSON.stringify({success:true}),{headers:{...corsHeaders,'Content-Type':'application/json'}});
        }
        if (surveyId) {
          imageKeys = await collectImageKeys(DB_URL, 'survey_id = $1', [surveyId]);
          await queryNeon(DB_URL, `DELETE FROM responses WHERE survey_id = $1;`, [surveyId]);
        } else {
          imageKeys = await collectImageKeys(DB_URL, '1=1');
          await queryNeon(DB_URL, `TRUNCATE TABLE responses;`);
        }
        await deleteImageKeys(env, imageKeys);

        return new Response(JSON.stringify({ success: true, message: 'All response data purged successfully.' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 5. Lưu / Cập nhật cấu hình bài khảo sát (Save Survey) - yêu cầu admin
      if (path === '/api/surveys' && request.method === 'POST') {
        if (!isAdminAuthorized(request, env)) return new Response(JSON.stringify({ error:'Unauthorized - cần đăng nhập admin'}),{status:401,headers:{...corsHeaders,'Content-Type':'application/json'}});
        const body = await request.json();
        const { id, title, description, questions } = body;
        if (!id) {
          return new Response(JSON.stringify({ error: 'Survey ID required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const questionsStr = typeof questions === 'string' ? questions : JSON.stringify(questions || []);

        await queryNeon(
          DB_URL,
          `INSERT INTO surveys (id, title, description, questions, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())
           ON CONFLICT (id) DO UPDATE SET
             title = EXCLUDED.title,
             description = EXCLUDED.description,
             questions = EXCLUDED.questions,
             updated_at = NOW();`,
          [id, title || '', description || '', questionsStr]
        );

        return new Response(JSON.stringify({ success: true, id }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 6. Lấy thông tin bài khảo sát: GET /api/surveys?id=... hoặc list all (list all yêu cầu admin, single id public cho participant)
      if (path === '/api/surveys' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id) {
          if (!isAdminAuthorized(request, env)) return new Response(JSON.stringify({ error:'Unauthorized - cần đăng nhập admin để xem danh sách khảo sát'}),{status:401,headers:{...corsHeaders,'Content-Type':'application/json'}});
          const rows = await queryNeon(DB_URL, `SELECT id, title, description, questions, created_at, updated_at FROM surveys ORDER BY updated_at DESC LIMIT 100;`);
          const list = Array.isArray(rows) ? rows : (rows && rows.rows ? rows.rows : []);
          const normalized = list.map(function(s){ if(typeof s.questions==='string'){ try{s.questions=JSON.parse(s.questions);}catch(e){} } return s; });
          return new Response(JSON.stringify(normalized), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const rows = await queryNeon(DB_URL, `SELECT * FROM surveys WHERE id = $1 LIMIT 1;`, [id]);
        const rowsList = Array.isArray(rows) ? rows : (rows && rows.rows ? rows.rows : []);

        if (rowsList.length === 0) {
          return new Response(JSON.stringify({ error: 'Survey not found' }), { status: 404, headers: corsHeaders });
        }
        const s = { ...rowsList[0] };
        if (typeof s.questions === 'string') {
          try { s.questions = JSON.parse(s.questions); } catch (e) {}
        }
        return new Response(JSON.stringify(s), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // 7. Xóa khảo sát: DELETE /api/surveys?id=... hoặc ids=... (xóa cả orphan responses)
      if (path === '/api/surveys' && request.method === 'DELETE') {
        if (!isAdminAuthorized(request, env)) return new Response(JSON.stringify({ error:'Unauthorized'}),{status:401,headers:corsHeaders});
        const id = url.searchParams.get('id');
        const ids = url.searchParams.get('ids');
        if (ids) {
          const idList = ids.split(',').map(function(s){return s.trim();}).filter(Boolean);
          let surveyImageKeys = [];
          for (var k=0;k<idList.length;k++) {
            surveyImageKeys.push(...await collectImageKeys(DB_URL, 'survey_id = $1', [idList[k]]));
          }
          for (var k=0;k<idList.length;k++) {
            var sid = idList[k];
            await queryNeon(DB_URL, `DELETE FROM responses WHERE survey_id = $1;`, [sid]);
            await queryNeon(DB_URL, `DELETE FROM surveys WHERE id = $1;`, [sid]);
          }
          await deleteImageKeys(env, surveyImageKeys);
          return new Response(JSON.stringify({ success: true, message: 'Đã xóa '+idList.length+' khảo sát và toàn bộ bài liên quan', ids: idList }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        if (!id) {
          return new Response(JSON.stringify({ error: 'Survey ID required' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        // Xóa orphan responses trước (kèm dọn ảnh đính kèm trên R2)
        const surveyImageKeys = await collectImageKeys(DB_URL, 'survey_id = $1', [id]);
        await queryNeon(DB_URL, `DELETE FROM responses WHERE survey_id = $1;`, [id]);
        await queryNeon(DB_URL, `DELETE FROM surveys WHERE id = $1;`, [id]);
        await deleteImageKeys(env, surveyImageKeys);

        return new Response(JSON.stringify({ success: true, message: 'Survey deleted', id }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ error: 'Endpoint not found' }), { status: 404, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
  }
};
