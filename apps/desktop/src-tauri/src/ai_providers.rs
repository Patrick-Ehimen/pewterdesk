//! The models behind PewterDesk AI, and how each one is asked: Anthropic's
//! Claude (Messages API), Google's Gemini (Interactions API) and OpenAI's
//! ChatGPT models (Responses API). `ai_assistant` runs the analyst - its
//! tools, its chart marks, its chats; this module only turns one round of
//! it into each provider's request and reads the answer back.
//!
//! Security invariants - review any change here against
//! `.claude/commands/security-review.md`:
//! - Each provider is reached at one fixed address (`Provider::endpoint`),
//!   by the client in `AiState`, which follows no redirects. Nothing here
//!   takes a URL or host from the page.
//! - Each provider's key lives in the keychain under its own entry
//!   (`Provider::key_account`), is sent only to that provider's address, in
//!   the header that provider expects, and is never returned or logged.
//!   Errors are put into words here; a response body is never echoed whole.
//! - The model is one of a fixed list per provider (`Provider::models`).
//! - A conversation is the provider's own transcript, appended to and handed
//!   back whole (every provider here checks its own reasoning signatures,
//!   so nothing in it is edited). A chat stays with the provider it began on.

use pewterdesk_core::VenueError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const CLAUDE_API: &str = "https://api.anthropic.com/v1/messages";
const CLAUDE_VERSION: &str = "2023-06-01";
/// Claude's refusal fallback, picked by Anthropic by the refusal's category.
const CLAUDE_FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const GEMINI_API: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
const OPENAI_API: &str = "https://api.openai.com/v1/responses";

const MAX_TOKENS: u32 = 16_000;
/// Searches the provider's own web search may run in one answer.
const WEB_SEARCHES: u32 = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Gemini,
    #[serde(rename = "openai")]
    OpenAi,
}

/// A model the trader can pick, as the page lists it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    provider: Provider,
    id: &'static str,
    label: &'static str,
    /// The provider's model when none is picked.
    default: bool,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Claude, Provider::Gemini, Provider::OpenAi];

    /// The keychain entry its key lives under.
    pub fn key_account(self) -> &'static str {
        match self {
            Provider::Claude => "anthropic:api",
            Provider::Gemini => "gemini:api",
            Provider::OpenAi => "openai:api",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Provider::Claude => "Anthropic",
            Provider::Gemini => "Google",
            Provider::OpenAi => "OpenAI",
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Provider::Claude => CLAUDE_API,
            Provider::Gemini => GEMINI_API,
            Provider::OpenAi => OPENAI_API,
        }
    }

    /// The models it may be asked with, the default first.
    pub fn models(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Provider::Claude => &[
                ("claude-opus-5-5", "Claude Opus 5.5"),
                ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
            ],
            Provider::Gemini => &[
                ("gemini-3.8-flash", "Gemini 3.8 Flash"),
                ("gemini-4-argon", "Gemini 4 Argon"),
                ("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite"),
            ],
            Provider::OpenAi => &[
                ("gpt-6-astra", "GPT-6 Astra"),
                ("gpt-6.1-sol", "GPT-6.1 Sol"),
                ("gpt-6-luna", "GPT-6 Luna"),
            ],
        }
    }

    pub fn has_model(self, id: &str) -> bool {
        self.models().iter().any(|(m, _)| *m == id)
    }

    /// Whether `key` looks like one of its keys: its own prefix where it has
    /// one, and only the characters keys use (Google's newer keys, "AQ.",
    /// have dots).
    pub fn key_ok(self, key: &str) -> bool {
        let dots = self == Provider::Gemini;
        let chars = key.len() <= 256
            && key.bytes().all(|b| {
                b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_') || (dots && b == b'.')
            });
        chars
            && match self {
                Provider::Claude => key.starts_with("sk-ant-"),
                Provider::OpenAi => key.starts_with("sk-") && !key.starts_with("sk-ant-"),
                Provider::Gemini => key.len() >= 20,
            }
    }
}

/// Every model the page can offer.
pub fn all_models() -> Vec<ModelInfo> {
    Provider::ALL
        .iter()
        .flat_map(|&provider| {
            provider
                .models()
                .iter()
                .enumerate()
                .map(move |(i, &(id, label))| ModelInfo {
                    provider,
                    id,
                    label,
                    default: i == 0,
                })
        })
        .collect()
}

/// A tool the model asked for.
pub struct Call {
    pub id: String,
    pub name: String,
    pub input: Value,
}

/// How a round ended.
#[derive(Debug, PartialEq, Eq)]
pub enum RoundEnd {
    /// It asked for tools: run them and go round again.
    Tools,
    /// A long turn paused: go round again as it is.
    Pause,
    Done,
    /// The output limit.
    CutShort,
    /// The model declined.
    Refused,
}

/// One request and its answer: what it said, and the tools it wants.
pub struct Round {
    pub text: String,
    pub calls: Vec<Call>,
    pub end: RoundEnd,
}

/// A tool's result, to hand back.
pub struct Outcome {
    pub id: String,
    pub name: String,
    pub text: String,
    pub error: bool,
}

/// Whether `transcript`'s entries are this provider's own kind.
pub fn transcript_ok(provider: Provider, transcript: &[Value]) -> bool {
    transcript.iter().all(|entry| match provider {
        Provider::Claude => {
            matches!(
                entry.get("role").and_then(Value::as_str),
                Some("user" | "assistant")
            ) && entry.get("content").is_some()
        }
        Provider::Gemini => entry.get("type").and_then(Value::as_str).is_some(),
        Provider::OpenAi => {
            entry.get("type").and_then(Value::as_str).is_some()
                || entry.get("role").and_then(Value::as_str).is_some()
        }
    })
}

/// The trader's question, with the screen's context, as a turn.
pub fn user_turn(provider: Provider, context: &str, question: &str) -> Value {
    match provider {
        Provider::Claude => json!({
            "role": "user",
            "content": [{"type": "text", "text": context}, {"type": "text", "text": question}],
        }),
        Provider::Gemini => json!({
            "type": "user_input",
            "content": [{"type": "text", "text": context}, {"type": "text", "text": question}],
        }),
        Provider::OpenAi => json!({
            "role": "user",
            "content": [
                {"type": "input_text", "text": context},
                {"type": "input_text", "text": question},
            ],
        }),
    }
}

/// The analyst's tools in each provider's form. `tools` is the neutral list:
/// `{name, description, input_schema}` each (every object closed, every
/// property required), web search added per provider.
///
/// Not in strict mode: a provider compiles strict schemas into one grammar,
/// and these tools together are past Claude's limit for it ("the compiled
/// grammar is too large"). Nothing relies on it - every tool's input is
/// checked in Rust (markets resolved, enums matched, numbers clamped, times
/// parsed), and what doesn't check out goes back to the model as an error.
pub fn tools_for(provider: Provider, tools: &[Value]) -> Value {
    let mut out: Vec<Value> = tools
        .iter()
        .map(|t| {
            let (name, description, schema) = (&t["name"], &t["description"], &t["input_schema"]);
            match provider {
                Provider::Claude => json!({
                    "name": name, "description": description, "input_schema": schema,
                }),
                Provider::Gemini => json!({
                    "type": "function", "name": name, "description": description, "parameters": schema,
                }),
                Provider::OpenAi => json!({
                    "type": "function", "name": name, "description": description,
                    "parameters": schema,
                }),
            }
        })
        .collect();
    out.push(match provider {
        Provider::Claude => {
            json!({"type": "web_search_20260209", "name": "web_search", "max_uses": WEB_SEARCHES})
        }
        Provider::Gemini => json!({"type": "google_search", "search_types": ["web_search"]}),
        Provider::OpenAi => json!({"type": "web_search"}),
    });
    Value::Array(out)
}

/// The provider's error, put into words the page can show. Never the request.
fn api_error(provider: Provider, status: reqwest::StatusCode, body: &str) -> VenueError {
    let message = serde_json::from_str::<Value>(body).ok().and_then(|v| {
        v.pointer("/error/message")
            .and_then(Value::as_str)
            .map(|m| {
                m.chars()
                    .filter(|c| !c.is_control())
                    .take(300)
                    .collect::<String>()
            })
    });
    let who = provider.name();
    // A provider isn't a venue: its refusals are invalid requests, not a venue's rejection.
    match status.as_u16() {
        401 | 403 => VenueError::InvalidRequest(format!("the {who} API key was refused")),
        429 => VenueError::InvalidRequest(format!(
            "{who}'s rate limit or quota: try again in a moment{}",
            message.map(|m| format!(" ({m})")).unwrap_or_default()
        )),
        500..=599 => VenueError::Network(format!("{who} is unavailable: try again in a moment")),
        _ => VenueError::InvalidRequest(match message {
            Some(m) => format!("{who}: {m}"),
            None => format!("{who} answered {status}"),
        }),
    }
}

async fn post(
    http: &reqwest::Client,
    provider: Provider,
    key: &str,
    body: &Value,
) -> Result<Value, VenueError> {
    let request = http.post(provider.endpoint()).json(body);
    let request = match provider {
        Provider::Claude => request
            .header("x-api-key", key)
            .header("anthropic-version", CLAUDE_VERSION)
            .header("anthropic-beta", CLAUDE_FALLBACK_BETA),
        Provider::Gemini => request.header("x-goog-api-key", key),
        Provider::OpenAi => request.bearer_auth(key),
    };
    let response = request
        .send()
        .await
        .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| VenueError::Network(e.without_url().to_string()))?;
    if !status.is_success() {
        return Err(api_error(provider, status, &text));
    }
    serde_json::from_str(&text).map_err(|e| VenueError::Network(e.to_string()))
}

fn texts<'a>(blocks: impl Iterator<Item = &'a Value>, kind: &str) -> String {
    blocks
        .filter(|b| b.get("type").and_then(Value::as_str) == Some(kind))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// A Gemini Interactions request. Every field is where the API's OpenAPI
/// spec puts it (`tool_choice` is in `generation_config`, not top level).
fn gemini_body(
    model: &str,
    system: &str,
    tools: &Value,
    messages: &[Value],
    effort: &str,
) -> Value {
    json!({
        "model": model,
        "input": messages,
        "system_instruction": system,
        "tools": tools,
        "generation_config": {
            "max_output_tokens": MAX_TOKENS,
            "thinking_level": effort,
            // Google Search with our functions: validated, not auto.
            "tool_choice": "validated",
        },
        "store": false,
    })
}

/// Who is asked, how, and with what: everything a round needs but the conversation.
pub struct Request<'a> {
    pub provider: Provider,
    pub key: &'a str,
    pub model: &'a str,
    pub system: &'a str,
    pub tools: &'a Value,
    /// Deep Think: harder reasoning, slower and dearer. A request setting,
    /// outside the conversation, so it can change from one question to the next.
    pub deep: bool,
}

/// Asks once, with the conversation so far, and appends the model's output
/// to `messages` as the provider gave it.
pub async fn round(
    http: &reqwest::Client,
    request: &Request<'_>,
    messages: &mut Vec<Value>,
) -> Result<Round, VenueError> {
    let Request {
        provider,
        key,
        model,
        system,
        tools,
        deep,
    } = *request;
    let effort = if deep { "high" } else { "medium" };
    match provider {
        Provider::Claude => {
            let body = json!({
                "model": model,
                "max_tokens": MAX_TOKENS,
                "fallbacks": "default",
                "system": system,
                "tools": tools,
                "thinking": {"type": "adaptive"},
                "output_config": {"effort": effort},
                "cache_control": {"type": "ephemeral"},
                "messages": messages,
            });
            let response = post(http, provider, key, &body).await?;
            let stop = response
                .get("stop_reason")
                .and_then(Value::as_str)
                .unwrap_or("");
            if stop == "refusal" {
                return Ok(Round {
                    text: String::new(),
                    calls: Vec::new(),
                    end: RoundEnd::Refused,
                });
            }
            let content = response
                .get("content")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let text = texts(content.iter(), "text");
            let calls = content
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                .filter_map(|b| {
                    Some(Call {
                        id: b.get("id")?.as_str()?.to_owned(),
                        name: b.get("name")?.as_str()?.to_owned(),
                        input: b.get("input").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect::<Vec<_>>();
            let end = match stop {
                "tool_use" if !calls.is_empty() => RoundEnd::Tools,
                "pause_turn" => RoundEnd::Pause,
                "max_tokens" => RoundEnd::CutShort,
                _ => RoundEnd::Done,
            };
            if !content.is_empty() {
                messages.push(json!({"role": "assistant", "content": content}));
            }
            Ok(Round { text, calls, end })
        }
        Provider::Gemini => {
            let body = gemini_body(model, system, tools, messages, effort);
            let response = post(http, provider, key, &body).await?;
            let status = response.get("status").and_then(Value::as_str).unwrap_or("");
            if status == "failed" {
                return Err(VenueError::Rejected("Gemini couldn't answer that".into()));
            }
            let steps = response
                .get("steps")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let text = steps
                .iter()
                .filter(|s| s.get("type").and_then(Value::as_str) == Some("model_output"))
                .map(|s| {
                    texts(
                        s.get("content")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten(),
                        "text",
                    )
                })
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            let calls = steps
                .iter()
                .filter(|s| s.get("type").and_then(Value::as_str) == Some("function_call"))
                .filter_map(|s| {
                    Some(Call {
                        id: s.get("id")?.as_str()?.to_owned(),
                        name: s.get("name")?.as_str()?.to_owned(),
                        input: s.get("arguments").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect::<Vec<_>>();
            let end = if !calls.is_empty() {
                RoundEnd::Tools
            } else if status == "incomplete" || status == "budget_exceeded" {
                RoundEnd::CutShort
            } else if steps.is_empty() {
                RoundEnd::Refused
            } else {
                RoundEnd::Done
            };
            messages.extend(steps);
            Ok(Round { text, calls, end })
        }
        Provider::OpenAi => {
            let body = json!({
                "model": model,
                "instructions": system,
                "input": messages,
                "tools": tools,
                "reasoning": {"effort": effort},
                "max_output_tokens": MAX_TOKENS,
                "store": false,
            });
            let response = post(http, provider, key, &body).await?;
            let output = response
                .get("output")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let refused = output.iter().any(|item| {
                item.get("content")
                    .and_then(Value::as_array)
                    .is_some_and(|c| {
                        c.iter()
                            .any(|b| b.get("type").and_then(Value::as_str) == Some("refusal"))
                    })
            });
            if refused {
                return Ok(Round {
                    text: String::new(),
                    calls: Vec::new(),
                    end: RoundEnd::Refused,
                });
            }
            let text = output
                .iter()
                .filter(|i| i.get("type").and_then(Value::as_str) == Some("message"))
                .map(|i| {
                    texts(
                        i.get("content")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten(),
                        "output_text",
                    )
                })
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            let calls = output
                .iter()
                .filter(|i| i.get("type").and_then(Value::as_str) == Some("function_call"))
                .filter_map(|i| {
                    // Arguments arrive as a JSON string.
                    let input =
                        serde_json::from_str(i.get("arguments")?.as_str()?).unwrap_or(Value::Null);
                    Some(Call {
                        id: i.get("call_id")?.as_str()?.to_owned(),
                        name: i.get("name")?.as_str()?.to_owned(),
                        input,
                    })
                })
                .collect::<Vec<_>>();
            let status = response.get("status").and_then(Value::as_str).unwrap_or("");
            let end = if !calls.is_empty() {
                RoundEnd::Tools
            } else if status == "incomplete" {
                RoundEnd::CutShort
            } else {
                RoundEnd::Done
            };
            messages.extend(output);
            Ok(Round { text, calls, end })
        }
    }
}

/// A round's tool results, as the entries to append.
pub fn results(provider: Provider, outcomes: Vec<Outcome>) -> Vec<Value> {
    match provider {
        // Every result of the round in one message.
        Provider::Claude => vec![json!({
            "role": "user",
            "content": outcomes.into_iter().map(|o| json!({
                "type": "tool_result", "tool_use_id": o.id, "content": o.text, "is_error": o.error,
            })).collect::<Vec<_>>(),
        })],
        Provider::Gemini => outcomes
            .into_iter()
            .map(|o| {
                json!({
                    "type": "function_result", "call_id": o.id, "name": o.name,
                    "result": [{"type": "text", "text": o.text}], "is_error": o.error,
                })
            })
            .collect(),
        Provider::OpenAi => outcomes
            .into_iter()
            .map(|o| {
                json!({
                    "type": "function_call_output", "call_id": o.id,
                    "output": if o.error { format!("error: {}", o.text) } else { o.text },
                })
            })
            .collect(),
    }
}

/// An answer cut short after its tool results ends on them; Claude needs a
/// turn of its own after them before the next question.
pub fn close_turn(provider: Provider, messages: &mut Vec<Value>, asked_at: usize) {
    if provider != Provider::Claude || messages.len() <= asked_at + 1 {
        return;
    }
    if messages
        .last()
        .and_then(|m| m.get("role"))
        .and_then(Value::as_str)
        == Some("user")
    {
        messages.push(json!({
            "role": "assistant",
            "content": [{"type": "text", "text": "(stopped here)"}],
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool() -> Value {
        json!({
            "name": "get_candles",
            "description": "Candles.",
            "input_schema": {"type": "object", "properties": {"market": {"type": "string"}}, "required": ["market"], "additionalProperties": false},
        })
    }

    #[test]
    fn writes_the_tools_in_each_providers_form() {
        let claude = tools_for(Provider::Claude, &[tool()]);
        assert_eq!(claude[0]["input_schema"]["required"], json!(["market"]));
        // Not strict: the tools together are too large a grammar for it.
        assert!(claude[0].get("strict").is_none());
        assert_eq!(claude[1]["type"], json!("web_search_20260209"));

        let gemini = tools_for(Provider::Gemini, &[tool()]);
        assert_eq!(gemini[0]["type"], json!("function"));
        assert_eq!(
            gemini[0]["parameters"]["properties"]["market"]["type"],
            json!("string")
        );
        assert_eq!(
            gemini[1],
            json!({"type": "google_search", "search_types": ["web_search"]})
        );

        let openai = tools_for(Provider::OpenAi, &[tool()]);
        assert!(openai[0].get("strict").is_none());
        assert_eq!(
            openai[0]["parameters"]["additionalProperties"],
            json!(false)
        );
        assert_eq!(openai[1], json!({"type": "web_search"}));
    }

    #[test]
    fn asks_gemini_only_with_fields_its_spec_has() {
        // From the Interactions API's OpenAPI spec (ModelInteraction, GenerationConfig).
        const TOP: [&str; 17] = [
            "model",
            "input",
            "system_instruction",
            "tools",
            "generation_config",
            "store",
            "stream",
            "background",
            "previous_interaction_id",
            "response_format",
            "response_mime_type",
            "response_modalities",
            "safety_settings",
            "service_tier",
            "webhook_config",
            "labels",
            "environment",
        ];
        const GENERATION: [&str; 9] = [
            "max_output_tokens",
            "seed",
            "stop_sequences",
            "thinking_level",
            "thinking_summaries",
            "tool_choice",
            "speech_config",
            "temperature",
            "top_p",
        ];
        let body = gemini_body("gemini-3.8-flash", "sys", &json!([]), &[], "high");
        assert_eq!(body["generation_config"]["thinking_level"], json!("high"));
        for key in body.as_object().unwrap().keys() {
            assert!(TOP.contains(&key.as_str()), "{key} isn't a request field");
        }
        for key in body["generation_config"].as_object().unwrap().keys() {
            assert!(
                GENERATION.contains(&key.as_str()),
                "{key} isn't a generation_config field"
            );
        }
        assert_eq!(body["generation_config"]["tool_choice"], json!("validated"));
        assert_eq!(body["store"], json!(false));
    }

    #[test]
    fn says_what_a_provider_refused_without_calling_it_a_venue() {
        let err = api_error(
            Provider::Gemini,
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"Unknown parameter 'x'."}}"#,
        );
        assert_eq!(
            err.to_string(),
            "invalid request: Google: Unknown parameter 'x'."
        );
        let err = api_error(Provider::OpenAi, reqwest::StatusCode::UNAUTHORIZED, "");
        assert_eq!(
            err.to_string(),
            "invalid request: the OpenAI API key was refused"
        );
    }

    #[test]
    fn hands_results_back_in_each_providers_form() {
        let outcome = || {
            vec![Outcome {
                id: "c1".into(),
                name: "get_candles".into(),
                text: "no".into(),
                error: true,
            }]
        };
        let claude = results(Provider::Claude, outcome());
        assert_eq!(claude.len(), 1);
        assert_eq!(claude[0]["content"][0]["tool_use_id"], json!("c1"));
        let gemini = results(Provider::Gemini, outcome());
        assert_eq!(gemini[0]["type"], json!("function_result"));
        assert_eq!(gemini[0]["call_id"], json!("c1"));
        let openai = results(Provider::OpenAi, outcome());
        assert_eq!(openai[0]["type"], json!("function_call_output"));
        assert_eq!(openai[0]["output"], json!("error: no"));
    }

    #[test]
    fn checks_keys_by_provider() {
        assert!(Provider::Claude.key_ok("sk-ant-api03-abc_DEF"));
        assert!(!Provider::Claude.key_ok("sk-proj-abc"));
        assert!(Provider::OpenAi.key_ok("sk-proj-abc_DEF-123"));
        assert!(!Provider::OpenAi.key_ok("sk-ant-api03-abc"));
        assert!(Provider::Gemini.key_ok("AIzaSyA1234567890abcdefghijklmnopqrs"));
        // Google's newer format, with dots (a made-up key of that shape).
        assert!(Provider::Gemini.key_ok("AQ.Ab8Xx0ExampleKeyOnly-not_real.Zz9"));
        assert!(!Provider::OpenAi.key_ok("sk-proj.abc"));
        assert!(!Provider::Gemini.key_ok("short"));
        assert!(!Provider::Gemini.key_ok("AIzaSyA1234567890abc def ghijklmnop"));
    }

    #[test]
    fn knows_each_providers_transcript() {
        let claude = [json!({"role": "user", "content": "hi"})];
        let gemini = [
            json!({"type": "user_input", "content": []}),
            json!({"type": "thought", "signature": "x"}),
        ];
        let openai = [
            json!({"role": "user", "content": []}),
            json!({"type": "reasoning", "encrypted_content": "x"}),
        ];
        assert!(transcript_ok(Provider::Claude, &claude));
        assert!(!transcript_ok(Provider::Claude, &gemini));
        assert!(transcript_ok(Provider::Gemini, &gemini));
        assert!(!transcript_ok(Provider::Gemini, &claude));
        assert!(transcript_ok(Provider::OpenAi, &openai));
    }

    #[test]
    fn lists_models_with_one_default_each() {
        let models = all_models();
        for provider in Provider::ALL {
            let mine: Vec<_> = models.iter().filter(|m| m.provider == provider).collect();
            assert_eq!(mine.iter().filter(|m| m.default).count(), 1);
            assert!(mine.iter().all(|m| provider.has_model(m.id)));
        }
        assert!(!Provider::Gemini.has_model("gpt-6-astra"));
    }

    #[test]
    fn closes_only_claudes_cut_short_turns() {
        let mut claude = vec![
            json!({"role": "user", "content": "q"}),
            json!({"role": "user", "content": []}),
        ];
        close_turn(Provider::Claude, &mut claude, 0);
        assert_eq!(claude.len(), 3);
        let mut gemini = vec![
            json!({"type": "user_input"}),
            json!({"type": "function_result"}),
        ];
        close_turn(Provider::Gemini, &mut gemini, 0);
        assert_eq!(gemini.len(), 2);
    }
}
