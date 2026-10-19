use pewterdesk_protocol::rpc::{
    code, read_request, Call, ClientInfo, ClientKind, Hello, Id, Request, Response, Target,
};

#[test]
fn a_request_round_trips() {
    let req = Request::new(
        Id::Num(1),
        Call::Hello(Hello {
            version: 1,
            client: ClientInfo {
                name: "pd".into(),
                kind: ClientKind::Pd,
            },
            token: None,
        }),
    );
    let text = serde_json::to_string(&req).unwrap();
    assert!(text.contains(r#""method":"hello""#), "{text}");
    assert_eq!(read_request(&text).unwrap(), req);
}

#[test]
fn a_method_without_params_reads() {
    let req = read_request(r#"{"jsonrpc":"2.0","id":"a","method":"status"}"#).unwrap();
    assert_eq!(req.call, Call::Status);
    assert_eq!(req.id, Id::Str("a".into()));
}

#[test]
fn a_trading_call_carries_its_target_flat() {
    let text = r#"{"jsonrpc":"2.0","id":2,"method":"order.cancel","params":
        {"venue":"bybit","account":"demo:1","market":"BTCUSDT","orderId":"9"}}"#;
    let req = read_request(text).unwrap();
    match &req.call {
        Call::CancelOrder {
            target,
            market,
            order_id,
        } => {
            assert_eq!(target.account, "demo:1");
            assert_eq!(market, "BTCUSDT");
            assert_eq!(order_id, "9");
            assert_eq!(target.origin, None);
        }
        other => panic!("read as {other:?}"),
    }
    assert!(req.call.trades());
    assert!(!req.call.open_to_unpaired());
}

#[test]
fn bad_input_gets_the_right_error() {
    let code_of = |text: &str| read_request(text).unwrap_err().error.unwrap().code;
    assert_eq!(code_of("not json"), code::PARSE);
    assert_eq!(
        code_of(r#"{"jsonrpc":"1.0","id":1,"method":"status"}"#),
        code::INVALID_REQUEST
    );
    assert_eq!(
        code_of(r#"{"jsonrpc":"2.0","method":"status"}"#),
        code::INVALID_REQUEST
    );
    assert_eq!(
        code_of(r#"{"jsonrpc":"2.0","id":1,"method":"withdraw"}"#),
        code::METHOD_NOT_FOUND
    );
    assert_eq!(
        code_of(r#"{"jsonrpc":"2.0","id":1,"method":"order.cancel","params":{}}"#),
        code::INVALID_PARAMS
    );
}

#[test]
fn only_hello_and_pairing_are_open_before_pairing() {
    let open = [
        r#"{"jsonrpc":"2.0","id":1,"method":"pair.status","params":{"requestId":"x"}}"#,
        r#"{"jsonrpc":"2.0","id":1,"method":"pair.request","params":{"client":{"name":"pd","kind":"pd"}}}"#,
    ];
    for text in open {
        assert!(
            read_request(text).unwrap().call.open_to_unpaired(),
            "{text}"
        );
    }
    for text in [
        r#"{"jsonrpc":"2.0","id":1,"method":"status"}"#,
        r#"{"jsonrpc":"2.0","id":1,"method":"halt"}"#,
        r#"{"jsonrpc":"2.0","id":1,"method":"clients.list"}"#,
    ] {
        assert!(
            !read_request(text).unwrap().call.open_to_unpaired(),
            "{text}"
        );
    }
}

#[test]
fn a_venue_error_comes_back_with_its_kind() {
    let err = pewterdesk_core::VenueError::Blocked("daily-loss".into());
    let res = Response::err(Some(Id::Num(3)), pewterdesk_protocol::RpcError::venue(&err));
    let back: Response = serde_json::from_str(&serde_json::to_string(&res).unwrap()).unwrap();
    let error = back.into_result::<()>().unwrap_err();
    assert_eq!(error.code, code::VENUE);
    assert_eq!(error.venue_kind(), Some("blocked"));
    let _ = Target {
        venue: pewterdesk_core::VenueId::Bybit,
        account: "1".into(),
        origin: None,
    };
}

#[test]
fn a_refusal_comes_back_as_the_same_venue_error() {
    use pewterdesk_core::VenueError;
    for err in [
        VenueError::Blocked("daily-loss".into()),
        VenueError::InvalidRequest("size".into()),
        VenueError::Rejected("no".into()),
    ] {
        let wire: pewterdesk_protocol::RpcError = serde_json::from_str(
            &serde_json::to_string(&pewterdesk_protocol::RpcError::venue(&err)).unwrap(),
        )
        .unwrap();
        assert_eq!(wire.to_venue_error(), err);
    }
    let other = pewterdesk_protocol::RpcError::new(code::UNPAIRED, "not paired");
    assert_eq!(
        other.to_venue_error(),
        VenueError::Network("not paired".into())
    );
}
