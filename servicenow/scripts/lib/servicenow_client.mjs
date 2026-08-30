// ServiceNow Table API呼び出しの共通処理。setup_rest_messages.mjs・sync_scheduled_job.mjsから
// 利用する。認証情報(SN_CLIENT_ID/SN_CLIENT_SECRET)はGitHub Actions Secrets経由の環境変数から
// 読む想定で、このファイル自身には一切含めない。

// SERVICENOW_INSTANCE_URL(GitHub Secret)は "dev395932.service-now.com" のようなホスト名でも
// "https://dev395932.service-now.com/" のような完全なURLでも渡され得るため、
// どちらの形式で登録されていても動くよう正規化する。
export function normalizeInstance(raw) {
  return String(raw || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

export function createClient({ instance, clientId, clientSecret }) {
  const INSTANCE = normalizeInstance(instance) || "dev395932.service-now.com";
  const BASE = `https://${INSTANCE}`;

  async function getToken() {
    const res = await fetch(`${BASE}/oauth_token.do`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`OAuthトークン取得に失敗: HTTP ${res.status} ${text}`);
    }
    const data = JSON.parse(text);
    if (!data.access_token) {
      throw new Error(`OAuthレスポンスにaccess_tokenが含まれていない: ${text}`);
    }
    return data.access_token;
  }

  async function api(token, method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    if (!res.ok) {
      throw new Error(`${method} ${path} が失敗: HTTP ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
  }

  async function findChoiceValue(token, table, element, labelIncludes) {
    const q = encodeURIComponent(`name=${table}^element=${element}`);
    const data = await api(
      token,
      "GET",
      `/api/now/table/sys_choice?sysparm_query=${q}&sysparm_fields=value,label&sysparm_limit=50`
    );
    const rows = data.result || [];
    const hit = rows.find((r) => (r.label || "").toLowerCase().includes(labelIncludes.toLowerCase()));
    if (!hit) {
      console.log(
        `[警告] ${table}.${element}: 「${labelIncludes}」を含む選択肢が見つからなかった。候補一覧: ${JSON.stringify(
          rows
        )} → この項目は未設定のままにします(ServiceNow側のデフォルト値に依存)`
      );
      return null;
    }
    return hit.value;
  }

  async function verifyFieldsExist(token, table, fields) {
    const q = encodeURIComponent(`name=${table}^elementIN${fields.join(",")}`);
    const data = await api(
      token,
      "GET",
      `/api/now/table/sys_dictionary?sysparm_query=${q}&sysparm_fields=element&sysparm_limit=100`
    );
    const found = new Set((data.result || []).map((r) => r.element));
    const missing = fields.filter((f) => !found.has(f));
    if (missing.length > 0) {
      console.log(
        `[警告] テーブル${table}に見つからないフィールド: ${missing.join(
          ", "
        )} (フィールド名がこのServiceNowバージョンでは異なる可能性。このまま試みますが、失敗した場合はここを疑ってください)`
      );
    } else {
      console.log(`[確認OK] テーブル${table}のフィールド ${fields.join(", ")} は実在を確認`);
    }
  }

  async function findByQuery(token, table, query, fields) {
    const q = encodeURIComponent(query);
    const fieldsParam = fields ? `&sysparm_fields=${encodeURIComponent(fields.join(","))}` : "";
    const data = await api(token, "GET", `/api/now/table/${table}?sysparm_query=${q}&sysparm_limit=1${fieldsParam}`);
    return (data.result || [])[0] || null;
  }

  return { BASE, getToken, api, findChoiceValue, verifyFieldsExist, findByQuery };
}
