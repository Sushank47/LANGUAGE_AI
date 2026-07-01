import json
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

# Add current directory to path to resolve imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Load local.settings.json to populate environment variables
settings_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'local.settings.json')
if os.path.exists(settings_path):
    try:
        with open(settings_path, 'r') as f:
            settings = json.load(f)
            values = settings.get('Values', {})
            for k, v in values.items():
                os.environ[k] = str(v)
            print("Loaded environment variables from local.settings.json")
    except Exception as e:
        print(f"Warning: Could not parse local.settings.json: {e}")

# Try importing azure.functions
try:
    import azure.functions as func  # type: ignore
except ImportError:
    print("Error: 'azure-functions' package is not installed.")
    print("Please install it: pip install azure-functions")
    sys.exit(1)

# Import the actual analyze handler
try:
    from analyze import main as analyze_handler
except ImportError as e:
    print(f"Error: Could not import analyze handler: {e}")
    sys.exit(1)

class LocalFunctionHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        # Handle CORS preflight
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path == '/' or self.path == '/index.html':
            # Serve the index.html file directly from the local server
            try:
                src_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
                html_path = os.path.join(src_dir, 'index.html')
                with open(html_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(content.encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'text/plain')
                self.end_headers()
                self.wfile.write(f"Error loading index.html: {str(e)}".encode('utf-8'))
        elif self.path == '/api/analyze':
            self.send_response(405)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Method Not Allowed. Use POST."}).encode('utf-8'))
        else:
            self.send_response(404)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(b"Not Found")

    def do_POST(self):
        if self.path != '/api/analyze':
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found. Endpoint is POST /api/analyze")
            return

        # Read request body
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        # Mock the azure.functions.HttpRequest class
        class MockHttpRequest(func.HttpRequest):  # type: ignore
            def __init__(self, method, url, headers, body_bytes):
                super().__init__(
                    method=method,
                    url=url,
                    headers=headers,
                    params={},
                    route_params={},
                    body=body_bytes
                )

        mock_req = MockHttpRequest(
            method="POST",
            url=self.path,
            headers={k: v for k, v in self.headers.items()},
            body_bytes=body
        )

        try:
            # Execute the actual Azure function logic
            response = analyze_handler(mock_req)
            
            # Send status code
            self.send_response(response.status_code)
            
            # Send headers
            for k, v in response.headers.items():
                self.send_header(k, v)
                
            if 'Content-Type' not in response.headers:
                self.send_header('Content-Type', 'application/json')
                
            self.end_headers()
            
            # Send body
            self.wfile.write(response.get_body())
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"Internal mock server error: {str(e)}"}).encode('utf-8'))

def run_server(port=7071):
    server_address = ('', port)
    httpd = HTTPServer(server_address, LocalFunctionHandler)
    print(f"Local Server simulating Azure Function running at: http://localhost:{port}/api/analyze")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        httpd.server_close()

if __name__ == '__main__':
    run_server()
