# Add to your main.py - near the top with other imports
import os

# Generate a device key if not set
DEVICE_API_KEY = os.getenv("DEVICE_API_KEY", "your-secret-device-key-here")

# Update the settings loading
def load_settings() -> Settings:
    device_api_key = os.getenv("DEVICE_API_KEY", "your-secret-device-key-here")
    # ... rest of the function