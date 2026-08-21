import requests
import time
import random

API_URL = "http://localhost:8000"
DEVICE_KEY = "your-secret-device-key-here"
BUS_ID = "bus-001"
ROUTE_ID = "demo"

def send_telemetry():
    """Simulate sending telemetry data"""
    data = {
        "bus_id": BUS_ID,
        "route_id": ROUTE_ID,
        "lat": 12.9716 + (random.random() - 0.5) * 0.01,
        "lng": 77.5946 + (random.random() - 0.5) * 0.01,
        "speed_kmh": random.randint(15, 50),
        "timestamp": int(time.time())
    }
    
    headers = {"X-Device-Key": DEVICE_KEY}
    
    try:
        response = requests.post(
            f"{API_URL}/telemetry",
            json=data,
            headers=headers
        )
        print(f"✅ Telemetry sent: {response.status_code}")
        return response.json()
    except Exception as e:
        print(f"❌ Error: {e}")
        return None

def get_live_status():
    """Get live status for bus"""
    try:
        response = requests.get(f"{API_URL}/live/{BUS_ID}")
        if response.status_code == 200:
            data = response.json()
            print(f"📍 Next stop: {data.get('next_stop', {}).get('station_name')}")
            print(f"⏱️ ETA: {data.get('next_stop', {}).get('eta_minutes')} min")
            return data
    except Exception as e:
        print(f"❌ Error: {e}")
        return None

if __name__ == "__main__":
    print("🚌 DriveOps Driver Test")
    print("-" * 40)
    
    # Send telemetry every 3 seconds
    for i in range(10):
        print(f"\n📡 Sending telemetry #{i+1}")
        result = send_telemetry()
        
        if i % 3 == 0:
            status = get_live_status()
        
        time.sleep(3)