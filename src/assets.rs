use axum::{
    body::Body,
    http::{header, StatusCode, Uri},
    response::Response,
};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "frontend/dist/"]
struct Assets;

pub async fn serve(uri: Uri) -> Response<Body> {
    let path = uri.path().trim_start_matches('/');
    let requested = if path.is_empty() { "index.html" } else { path };
    if let Some(asset) = Assets::get(requested) {
        return asset_response(requested, asset.data.into_owned());
    }
    if std::path::Path::new(requested).extension().is_none() {
        if let Some(index) = Assets::get("index.html") {
            return asset_response("index.html", index.data.into_owned());
        }
    }
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::from("Not Found"))
        .expect("valid static response")
}

fn asset_response(path: &str, bytes: Vec<u8>) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            mime_guess::from_path(path).first_or_octet_stream().as_ref(),
        )
        .body(Body::from(bytes))
        .expect("valid embedded asset response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn serves_spa_and_rejects_missing_assets() {
        assert_eq!(serve(Uri::from_static("/")).await.status(), StatusCode::OK);
        assert_eq!(
            serve(Uri::from_static("/projects/current")).await.status(),
            StatusCode::OK
        );
        assert_eq!(
            serve(Uri::from_static("/missing.js")).await.status(),
            StatusCode::NOT_FOUND
        );
    }
}
