import azure.functions as func  # type: ignore
import json
import os
import urllib.request
import urllib.error

def main(req: func.HttpRequest) -> func.HttpResponse:
    # Handle preflight options request for CORS support
    headers_response = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    }
    
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers=headers_response)

    # 1. Parse request body
    try:
        req_body = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps({"error": "Invalid JSON body. Please provide a JSON object."}),
            status_code=400,
            headers=headers_response
        )
    
    text = req_body.get("text")
    if not text or not isinstance(text, str) or not text.strip():
        return func.HttpResponse(
            json.dumps({"error": "The 'text' field is required and must be a non-empty string."}),
            status_code=400,
            headers=headers_response
        )
    
    # 2. Get API credentials from environment
    api_key = os.environ.get("AZURE_COGNITIVE_API_KEY", "")
    endpoint = os.environ.get("AZURE_COGNITIVE_ENDPOINT", "")
    
    # Normalize endpoint URL
    endpoint = endpoint.strip().rstrip("/")
    url = f"{endpoint}/language/:analyze-text?api-version=2022-05-01"
    
    headers = {
        "Ocp-Apim-Subscription-Key": api_key,
        "Content-Type": "application/json"
    }
    
    # Synchronous helper to query Azure REST API
    def call_azure_api(kind, extra_params=None):
        params = {
            "modelVersion": "latest"
        }
        if extra_params:
            params.update(extra_params)
            
        payload = {
            "kind": kind,
            "parameters": params,
            "analysisInput": {
                "documents": [
                    {
                        "id": "1",
                        "language": "en",
                        "text": text
                    }
                ]
            }
        }
        
        payload_bytes = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(url, data=payload_bytes, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request) as response:
                res_body = response.read().decode("utf-8")
                return json.loads(res_body), None
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8")
            friendly_msg = f"HTTP Error {e.code}: {e.reason}"
            if e.code == 401:
                friendly_msg = "Azure subscription key is unauthorized or invalid. Please verify the 'AZURE_COGNITIVE_API_KEY' in your local.settings.json."
            elif e.code == 404:
                friendly_msg = "Azure Endpoint resource not found. Please verify the endpoint URL 'AZURE_COGNITIVE_ENDPOINT' in local.settings.json."
            elif e.code == 429:
                friendly_msg = "Azure API rate limit/quota exceeded. Please wait a moment before trying again."
            
            try:
                err_json = json.loads(err_body)
                if "error" in err_json and "message" in err_json["error"]:
                    friendly_msg += f" Details: {err_json['error']['message']}"
            except Exception:
                pass
                
            return None, {"error": friendly_msg, "code": e.code}
        except urllib.error.URLError as e:
            friendly_msg = f"Network Connection Error: {e.reason}. Verify your internet connection and check if the AZURE_COGNITIVE_ENDPOINT is correct."
            return None, {"error": friendly_msg, "code": "NetworkError"}
        except Exception as e:
            return None, {"error": f"Internal Connection Failure: {str(e)}", "code": "GeneralError"}

    # Call APIs (Enabling Opinion Mining for SentimentAnalysis)
    sentiment_res, sentiment_err = call_azure_api("SentimentAnalysis", {"opinionMining": True})
    keyphrases_res, keyphrases_err = call_azure_api("KeyPhraseExtraction")
    entities_res, entities_err = call_azure_api("EntityRecognition")
    
    errors = {}
    if sentiment_err:
        errors["sentiment"] = sentiment_err
    if keyphrases_err:
        errors["keyphrases"] = keyphrases_err
    if entities_err:
        errors["entities"] = entities_err
        
    result = {
        "sentiment": None,
        "keyPhrases": [],
        "entities": [],
        "opinions": [],
        "errors": errors if errors else None
    }
    
    # Parse sentiment
    if sentiment_res and "results" in sentiment_res:
        docs = sentiment_res["results"].get("documents", [])
        if docs:
            doc = docs[0]
            result["sentiment"] = {
                "label": doc.get("sentiment"),
                "confidenceScores": doc.get("confidenceScores")
            }
            
            # Extract target-based opinions (Opinion Mining)
            opinions = []
            for sentence in doc.get("sentences", []):
                for target in sentence.get("targets", []):
                    assessments_list = []
                    for rel in target.get("relations", []):
                        if rel.get("relationType") == "assessment":
                            ref_path = rel.get("ref", "")
                            try:
                                parts = ref_path.split("/")
                                if parts[-2] == "assessments":
                                    idx = int(parts[-1])
                                    assessments = sentence.get("assessments", [])
                                    if 0 <= idx < len(assessments):
                                        assessments_list.append(assessments[idx].get("text"))
                            except Exception:
                                pass
                    opinions.append({
                        "target": target.get("text"),
                        "sentiment": target.get("sentiment"),
                        "assessments": assessments_list
                    })
            result["opinions"] = opinions
            
    # Parse key phrases
    if keyphrases_res and "results" in keyphrases_res:
        docs = keyphrases_res["results"].get("documents", [])
        if docs:
            doc = docs[0]
            result["keyPhrases"] = doc.get("keyPhrases", [])
            
    # Parse entities
    if entities_res and "results" in entities_res:
        docs = entities_res["results"].get("documents", [])
        if docs:
            doc = docs[0]
            result["entities"] = [
                {
                    "text": ent.get("text"),
                    "category": ent.get("category"),
                    "subcategory": ent.get("subcategory"),
                    "confidenceScore": ent.get("confidenceScore")
                }
                for ent in doc.get("entities", [])
            ]
            
    # Return aggregated data
    status = 200
    if errors:
        if len(errors) == 3:
            status = 500
        else:
            status = 207
            
    return func.HttpResponse(
        json.dumps(result),
        status_code=status,
        headers=headers_response
    )
