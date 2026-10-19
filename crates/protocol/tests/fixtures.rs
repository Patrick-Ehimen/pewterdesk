//! The command language's contract: every line in
//! `tests/fixtures/commands.json` parses here to what the app's TS parser
//! read it as (`apps/desktop/tests/commandFixtures.test.ts` checks the same
//! file from the other side).

use std::collections::HashMap;

use pewterdesk_protocol::command::{parse_command, parse_line, CommandContext};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Fixtures {
    version: u32,
    pages: Vec<String>,
    contexts: HashMap<String, CommandContext>,
    commands: Vec<Case>,
    lines: Vec<LineCase>,
}

#[derive(Deserialize)]
struct Case {
    context: String,
    line: String,
    intent: Value,
}

#[derive(Deserialize)]
struct LineCase {
    context: String,
    line: String,
    result: Value,
}

fn fixtures() -> Fixtures {
    let text = include_str!("../../../tests/fixtures/commands.json");
    serde_json::from_str(text).expect("the fixture file reads")
}

#[test]
fn every_command_parses_as_the_fixture_says() {
    let f = fixtures();
    assert_eq!(f.version, 1);
    let mut wrong = Vec::new();
    for case in &f.commands {
        let ctx = &f.contexts[&case.context];
        let got = serde_json::to_value(parse_command(&case.line, ctx)).unwrap();
        if got != case.intent {
            wrong.push(format!(
                "{:?} [{}]\n  want {}\n  got  {}",
                case.line, case.context, case.intent, got
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} of {} differ:\n{}",
        wrong.len(),
        f.commands.len(),
        wrong.join("\n")
    );
}

#[test]
fn every_cli_line_parses_as_the_fixture_says() {
    let f = fixtures();
    let mut wrong = Vec::new();
    for case in &f.lines {
        let ctx = &f.contexts[&case.context];
        let got = serde_json::to_value(parse_line(&case.line, ctx, &f.pages)).unwrap();
        if got != case.result {
            wrong.push(format!(
                "{:?}\n  want {}\n  got  {}",
                case.line, case.result, got
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} differ:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}
