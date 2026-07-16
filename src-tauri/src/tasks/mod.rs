pub mod frac;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A board column (coordination status). Order in `Columns.columns` is display order.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub id: String,
    pub name: String,
}

/// The volatile part of a claim — kept out of the committed card (see `.claims/` sidecar).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub by: String,        // session id, or "human"
    pub at: u64,
    pub lease_until: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub by: String,
    pub at: u64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardLinks {
    #[serde(default)]
    pub work_item: Option<String>,
    #[serde(default)]
    pub pr: String,
    #[serde(default)]
    pub branch: String,
}

/// One card = one file at `.conduit/board/cards/<id>.yaml`. `workflow` is always `null` in
/// Plan A; a later plan fills it with the stage-gate overlay.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub column: String,
    pub order: String,
    #[serde(default)]
    pub labels: Vec<String>,
    pub created_by: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub workflow: Option<Value>,
    #[serde(default)]
    pub links: CardLinks,
    #[serde(default)]
    pub comments: Vec<Comment>,
    // Populated from the `.claims/` sidecar at load time; skipped on card serialization.
    #[serde(skip)]
    pub claim: Option<Claim>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_yaml_round_trip_is_camel_case_and_lossless() {
        let card = Card {
            id: "c1".into(),
            title: "Do X".into(),
            body: "details".into(),
            column: "todo".into(),
            order: "U".into(),
            labels: vec!["web".into()],
            created_by: "human".into(),
            created_at: 1,
            updated_at: 2,
            workflow: None,
            links: CardLinks::default(),
            comments: vec![],
            claim: None,
        };
        let yaml = serde_yaml::to_string(&card).unwrap();
        assert!(yaml.contains("createdBy:"), "got:\n{yaml}");
        assert!(!yaml.contains("claim:"), "volatile claim must not serialize");
        let back: Card = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(card, back);
    }
}
