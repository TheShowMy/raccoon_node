fn referenced_pi_session_paths(data: &AppData, session_dir: &Path) -> HashSet<PathBuf> {
    data.requirements
        .iter()
        .filter_map(|requirement| requirement.pi_session_file.as_ref())
        .chain(
            data.project_chats
                .iter()
                .filter_map(|chat| chat.pi_session_file.as_ref()),
        )
        .filter_map(|session_file| {
            let path = PathBuf::from(session_file);
            let resolved = if path.is_absolute() {
                path
            } else {
                session_dir.join(path)
            };
            if ensure_child_path(session_dir, &resolved).is_err() {
                return None;
            }
            Some(std::fs::canonicalize(&resolved).unwrap_or(resolved))
        })
        .collect()
}

fn project_chat_response_from(chat: &ProjectChat) -> ProjectChatResponse {
    ProjectChatResponse {
        project_id: chat.project_id.clone(),
        messages: chat.messages.clone(),
        running: chat.running,
        error: chat.error.clone(),
        updated_at: chat.updated_at,
    }
}

fn build_requirement_conversation(requirement: Requirement) -> RequirementConversationResponse {
    let mut items = Vec::new();
    for (index, message) in requirement.messages.iter().enumerate() {
        let id = format!("message-{index}");
        match message.role {
            RequirementMessageRole::User => items.push(RequirementConversationItem::User {
                id,
                text: message.content.clone(),
                references: message.references.clone(),
                images: message.images.clone(),
                created_at: message.created_at,
            }),
            RequirementMessageRole::Assistant => {
                items.push(RequirementConversationItem::Assistant {
                    id,
                    text: message.content.clone(),
                    created_at: message.created_at,
                })
            }
            RequirementMessageRole::System => items.push(RequirementConversationItem::Notice {
                id,
                level: RequirementNoticeLevel::Warn,
                text: message.content.clone(),
                created_at: message.created_at,
            }),
            RequirementMessageRole::Trace => items.push(RequirementConversationItem::Process {
                id,
                title: message.content.clone(),
                status: if requirement.status == RequirementStatus::Failed {
                    RequirementProcessStatus::Error
                } else {
                    RequirementProcessStatus::Done
                },
                metadata: message.metadata.clone(),
                created_at: message.created_at,
            }),
        }
    }

    let prompt = match &requirement.active_prompt {
        Some(RequirementPromptState::Clarification {
            prompt_id,
            revision,
            round,
            questions,
        }) => Some(RequirementConversationPrompt::Clarification {
            round: *round,
            questions: questions.clone(),
            prompt_id: Some(prompt_id.clone()),
            revision: Some(*revision),
        }),
        Some(RequirementPromptState::Confirmation {
            prompt_id,
            revision,
            draft,
        }) => Some(RequirementConversationPrompt::Confirmation {
            draft: draft.clone(),
            prompt_id: Some(prompt_id.clone()),
            revision: Some(*revision),
        }),
        None => match requirement.status {
            RequirementStatus::Clarifying if !requirement.clarifications.is_empty() => {
                Some(RequirementConversationPrompt::Clarification {
                    round: requirement.clarification_round,
                    questions: requirement.clarifications.clone(),
                    prompt_id: None,
                    revision: None,
                })
            }
            RequirementStatus::DraftReady => requirement.draft.clone().map(|draft| {
                RequirementConversationPrompt::Confirmation {
                    draft,
                    prompt_id: None,
                    revision: None,
                }
            }),
            _ => None,
        },
    };

    let running = matches!(
        requirement.status,
        RequirementStatus::Analyzing | RequirementStatus::Planning | RequirementStatus::Running
    );

    if let Some(error) = &requirement.error {
        let has_error_notice = items.iter().any(|item| {
            matches!(
                item,
                RequirementConversationItem::Notice {
                    level: RequirementNoticeLevel::Warn,
                    text,
                    ..
                } if text.contains(error)
            )
        });
        if !has_error_notice {
            items.push(RequirementConversationItem::Notice {
                id: "requirement-error".to_owned(),
                level: RequirementNoticeLevel::Warn,
                text: error.clone(),
                created_at: requirement.updated_at,
            });
        }
    }

    RequirementConversationResponse {
        id: requirement.id,
        project_id: requirement.project_id,
        title: requirement.title,
        status: requirement.status,
        running,
        items,
        prompt,
        error: requirement.error,
        updated_at: requirement.updated_at,
    }
}
