/* 会话内容存档 SDK 的桩实现（stub）。
 *
 * 目的：在没有腾讯真实二进制、没有企业席位的情况下，把「Node → helper 进程 →
 * ctypes → C 动态库」这条跨界链路整个跑通并测绿。
 *
 * ★ ABI 以官方头文件为准（2026-11-12 用两份独立镜像交叉核对，逐字一致）：
 *
 *     typedef struct Slice_t { char* buf; int len; } Slice_t;
 *     typedef struct MediaData { char* outindexbuf; int out_len;
 *                                char* data; int data_len; int is_finish; } MediaData_t;
 *
 *     WeWorkFinanceSdk_t* NewSdk();
 *     int  Init(WeWorkFinanceSdk_t*, const char* corpid, const char* secret);
 *     int  GetChatData(sdk, unsigned long long seq, unsigned int limit,
 *                      const char* proxy, const char* passwd, int timeout, Slice_t*);
 *     int  DecryptData(const char* encrypt_key, const char* encrypt_msg, Slice_t*);
 *     int  GetMediaData(sdk, const char* indexbuf, const char* sdkFileid,
 *                       const char* proxy, const char* passwd, int timeout, MediaData_t*);
 *     void DestroySdk(WeWorkFinanceSdk_t*);
 *     Slice_t* NewSlice(); void FreeSlice(Slice_t*);
 *     char* GetContentFromSlice(Slice_t*); int GetSliceLen(Slice_t*);
 *     MediaData_t* NewMediaData(); void FreeMediaData(MediaData_t*);
 *     char* GetOutIndexBuf(MediaData_t*); char* GetData(MediaData_t*);
 *     int GetIndexLen(MediaData_t*); int GetDataLen(MediaData_t*); int IsMediaDataFinish(MediaData_t*);
 *
 * 三处曾经写错、且都不会在"桩上绿灯"时暴露的地方，这里逐条钉住：
 *   1. `GetChatData` 回的是 **JSON 信封** `{"errcode":0,"errmsg":"ok","chatdata":[...]}`，
 *      不是裸数组。把 dict 当 list 用 → 每次拉取都"成功"但零条消息，游标照推，永久丢数据。
 *   2. 媒体用 **MediaData_t**，不是 Slice_t；`GetOutIndexBuf` 收的是 MediaData_t*。
 *   3. 取切片内容用 **GetContentFromSlice**；`GetSliceData` 在真库里不存在。
 *
 * 配置：环境变量 ARCHIVE_STUB_CONFIG 指向一个制表符分隔的文本文件，行格式：
 *   BATCH <seq> <JSON 消息数组>
 *   PLAIN <encrypt_chat_msg> <解密后的明文 JSON>
 *   MEDIA <sdkfileid> <索引> <十六进制分块>
 *   ERR   <op> <errcode> <message>          # 让某个 op 固定失败（注入测试）
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LINE_MAX_LEN 262144
#define FIELD_MAX 4

typedef struct WeWorkFinanceSdk_t {
  char corpid[256];
  char secret[512];
  int inited;
} WeWorkFinanceSdk_t;

/* 官方布局，字段顺序与类型不可改。 */
typedef struct Slice_t {
  char *buf;
  int len;
} Slice_t;

/* 官方布局：媒体与聊天记录用**不同**的结构体。 */
typedef struct MediaData {
  char *outindexbuf;
  int out_len;
  char *data;
  int data_len;
  int is_finish;
} MediaData_t;

static char g_cfg_path[1024];

static int cfg_path(void) {
  if (g_cfg_path[0]) return 1;
  const char *p = getenv("ARCHIVE_STUB_CONFIG");
  if (!p) return 0;
  strncpy(g_cfg_path, p, sizeof(g_cfg_path) - 1);
  return 1;
}

static void set_slice(Slice_t *s, const char *text) {
  if (!s) return;
  size_t n = text ? strlen(text) : 0;
  char *copy = (char *)malloc(n + 1);
  if (!copy) return;
  if (n) memcpy(copy, text, n);
  copy[n] = 0;
  free(s->buf);
  s->buf = copy;
  s->len = (int)n;
}

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return 0;
}

static char *hex_to_bytes(const char *hex, int *out_len) {
  size_t digits = hex ? strlen(hex) : 0;
  size_t n = digits / 2;
  char *buf = (char *)malloc(n + 1);
  if (!buf) {
    *out_len = 0;
    return NULL;
  }
  for (size_t i = 0; i < n; i++) {
    buf[i] = (char)((hexval(hex[2 * i]) << 4) | hexval(hex[2 * i + 1]));
  }
  buf[n] = 0;
  *out_len = (int)n;
  return buf;
}

static void set_media(MediaData_t *m, const char *hex, const char *next_index, int is_finish) {
  if (!m) return;
  int len = 0;
  char *bytes = hex_to_bytes(hex, &len);
  free(m->data);
  m->data = bytes;
  m->data_len = len;

  size_t n = next_index ? strlen(next_index) : 0;
  char *copy = (char *)malloc(n + 1);
  if (copy) {
    if (n) memcpy(copy, next_index, n);
    copy[n] = 0;
  }
  free(m->outindexbuf);
  m->outindexbuf = copy;
  m->out_len = (int)n;
  m->is_finish = is_finish ? 1 : 0;
}

/* 把一行按 \t 切成最多 4 段（原地改写）。返回段数。 */
static int split_tabs(char *line, char *out[FIELD_MAX]) {
  int n = 0;
  out[n++] = line;
  for (char *p = line; *p && n < FIELD_MAX; p++) {
    if (*p == '\t') {
      *p = 0;
      out[n++] = p + 1;
    }
  }
  return n;
}

/* 找第一条满足 kind（与可选 key1）的行，把第 3/4 段拷出来。 */
static int find_row(const char *kind, const char *key1, char *f3, char *f4, int *int1) {
  if (!cfg_path()) return 0;
  FILE *fp = fopen(g_cfg_path, "r");
  if (!fp) return 0;
  char *line = (char *)malloc(LINE_MAX_LEN);
  if (!line) {
    fclose(fp);
    return 0;
  }
  int found = 0;
  while (fgets(line, LINE_MAX_LEN, fp)) {
    size_t n = strlen(line);
    while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
    if (!n) continue;
    char *parts[FIELD_MAX] = {0};
    int count = split_tabs(line, parts);
    if (count < 2) continue;
    if (strcmp(parts[0], kind) != 0) continue;
    if (key1 && strcmp(parts[1], key1) != 0) continue;
    if (int1 && count >= 2) *int1 = atoi(parts[1]);
    if (f3 && count >= 3) {
      strncpy(f3, parts[2], LINE_MAX_LEN - 1);
      f3[LINE_MAX_LEN - 1] = 0;
    }
    if (f4 && count >= 4) {
      strncpy(f4, parts[3], LINE_MAX_LEN - 1);
      f4[LINE_MAX_LEN - 1] = 0;
    }
    found = 1;
    break;
  }
  free(line);
  fclose(fp);
  return found;
}

/* ── 导出符号（与官方一一对应，不多不少）───────────────────────────── */

WeWorkFinanceSdk_t *NewSdk(void) {
  WeWorkFinanceSdk_t *sdk = (WeWorkFinanceSdk_t *)calloc(1, sizeof(WeWorkFinanceSdk_t));
  return sdk;
}

void DestroySdk(WeWorkFinanceSdk_t *sdk) { free(sdk); }

Slice_t *NewSlice(void) { return (Slice_t *)calloc(1, sizeof(Slice_t)); }

void FreeSlice(Slice_t *slice) {
  if (!slice) return;
  free(slice->buf);
  free(slice);
}

char *GetContentFromSlice(Slice_t *slice) { return slice ? slice->buf : NULL; }

int GetSliceLen(Slice_t *slice) { return slice ? slice->len : 0; }

MediaData_t *NewMediaData(void) { return (MediaData_t *)calloc(1, sizeof(MediaData_t)); }

void FreeMediaData(MediaData_t *m) {
  if (!m) return;
  free(m->outindexbuf);
  free(m->data);
  free(m);
}

char *GetOutIndexBuf(MediaData_t *m) { return m ? m->outindexbuf : NULL; }
char *GetData(MediaData_t *m) { return m ? m->data : NULL; }
int GetIndexLen(MediaData_t *m) { return m ? m->out_len : 0; }
int GetDataLen(MediaData_t *m) { return m ? m->data_len : 0; }
int IsMediaDataFinish(MediaData_t *m) { return m && m->is_finish ? 1 : 0; }

int Init(WeWorkFinanceSdk_t *sdk, const char *corpid, const char *secret) {
  if (!sdk) return 10001; /* 参数错误 */
  if (find_row("ERR", "init", NULL, NULL, NULL)) {
    char msg[LINE_MAX_LEN] = {0};
    int code = 0;
    find_row("ERR", "init", msg, NULL, &code);
    return code ? code : 10001;
  }
  /* 真库在这里拒绝"普通应用 secret"：会话存档的 secret 要在
     「管理工具 → 聊天内容存档」单独生成。形状校验只是桩的替身手段。 */
  if (!secret || strlen(secret) < 8) return 10000; /* 参数错误（secret 形状不对） */
  strncpy(sdk->corpid, corpid ? corpid : "", sizeof(sdk->corpid) - 1);
  strncpy(sdk->secret, secret, sizeof(sdk->secret) - 1);
  sdk->inited = 1;
  return 0;
}

int GetChatData(WeWorkFinanceSdk_t *sdk, unsigned long long seq, unsigned int limit,
                const char *proxy, const char *passwd, int timeout, Slice_t *chatDatas) {
  (void)proxy;
  (void)passwd;
  (void)timeout;
  if (!sdk || !sdk->inited) {
    set_slice(chatDatas, "{\"errcode\":10003,\"errmsg\":\"sdk not inited\"}");
    return 10003;
  }
  if (limit == 0 || limit > 1000) {
    /* 官方头文件：一次最多 1000 条，超过 1000 会返回错误。
       参数错误是 10000（不是 10001——10001 是网络错误）。 */
    if (chatDatas) set_slice(chatDatas, "{\"errcode\":10000,\"errmsg\":\"limit must be <= 1000\"}");
    return 10000;
  }

  /* 错误注入 */
  if (cfg_path()) {
    FILE *fp = fopen(g_cfg_path, "r");
    if (fp) {
      char *line = (char *)malloc(LINE_MAX_LEN);
      while (line && fgets(line, LINE_MAX_LEN, fp)) {
        char *parts[FIELD_MAX] = {0};
        int count = split_tabs(line, parts);
        if (count >= 4 && strcmp(parts[0], "ERR") == 0 &&
            (strcmp(parts[1], "getChatData") == 0 || strcmp(parts[1], "*") == 0)) {
          int code = atoi(parts[2]);
          if (chatDatas) set_slice(chatDatas, parts[3]);
          free(line);
          fclose(fp);
          return code;
        }
      }
      free(line);
      fclose(fp);
    }
  }

  /* 选第一条 batch.seq > 请求 seq 的批次，包进官方信封 */
  const char *empty = "[]";
  const char *body = empty;
  char *owned = NULL;
  if (cfg_path()) {
    FILE *fp = fopen(g_cfg_path, "r");
    if (fp) {
      char *line = (char *)malloc(LINE_MAX_LEN);
      while (line && fgets(line, LINE_MAX_LEN, fp)) {
        size_t n = strlen(line);
        while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
        char *parts[FIELD_MAX] = {0};
        int count = split_tabs(line, parts);
        if (count < 3 || strcmp(parts[0], "BATCH") != 0) continue;
        unsigned long long batchSeq = strtoull(parts[1], NULL, 10);
        if (batchSeq <= seq) continue;
        body = parts[2];
        break;
      }
      free(line);
      fclose(fp);
    }
  }

  size_t need = strlen(body) + 64;
  owned = (char *)malloc(need);
  if (!owned) return 10003;
  snprintf(owned, need, "{\"errcode\":0,\"errmsg\":\"ok\",\"chatdata\":%s}", body);
  set_slice(chatDatas, owned);
  free(owned);
  return 0;
}

int DecryptData(const char *encrypt_key, const char *encrypt_msg, Slice_t *msg) {
  if (!encrypt_key || !encrypt_msg) return 10001;
  char plain[LINE_MAX_LEN] = {0};
  if (find_row("PLAIN", encrypt_msg, plain, NULL, NULL)) {
    set_slice(msg, plain);
    return 0;
  }
  set_slice(msg, "");
  /* 10006 = 解密失败。真机上最常见的两个原因：私钥版本不对（10007）、
     encrypt_random_key 解析不出来（10008）。桩这里统一回 10006。 */
  return 10006;
}

int GetMediaData(WeWorkFinanceSdk_t *sdk, const char *indexbuf, const char *sdkfileid,
                 const char *proxy, const char *passwd, int timeout, MediaData_t *media_data) {
  (void)proxy;
  (void)passwd;
  (void)timeout;
  if (!sdk || !sdk->inited) return 10003;
  if (!sdkfileid) return 10005; /* fileid 错误 */
  int want = (indexbuf && indexbuf[0]) ? atoi(indexbuf) : 0;

  if (!cfg_path()) {
    set_media(media_data, "", "", 1);
    return 0;
  }
  FILE *fp = fopen(g_cfg_path, "r");
  if (!fp) return 0;
  char *line = (char *)malloc(LINE_MAX_LEN);
  int total = 0;
  char *chosen = NULL;
  while (line && fgets(line, LINE_MAX_LEN, fp)) {
    size_t n = strlen(line);
    while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
    char *parts[FIELD_MAX] = {0};
    int count = split_tabs(line, parts);
    if (count < 4 || strcmp(parts[0], "MEDIA") != 0) continue;
    if (strcmp(parts[1], sdkfileid) != 0) continue;
    int idx = atoi(parts[2]);
    if (idx > total) total = idx;
    if (idx == want) {
      free(chosen);
      chosen = strdup(parts[3]);
    }
  }
  free(line);
  fclose(fp);

  if (!chosen) {
    set_media(media_data, "", "", 1);
    return 0;
  }
  char next[32];
  int finished = (want >= total);
  if (!finished) snprintf(next, sizeof(next), "%d", want + 1);
  else next[0] = 0;
  set_media(media_data, chosen, next, finished);
  free(chosen);
  return 0;
}
