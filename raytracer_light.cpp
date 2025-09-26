#include <emscripten.h>
#include <vector>
#include <string>
#include <cmath>
#include <limits>
#include <algorithm>

// --- Data Structures ---
struct Vec3 { double x = 0, y = 0, z = 0; };
struct Color { double r = 0, g = 0, b = 0; };
struct Ray { Vec3 origin; Vec3 direction; };

// --- Vector Math ---
Vec3 vec_add(const Vec3& v1, const Vec3& v2) { return {v1.x + v2.x, v1.y + v2.y, v1.z + v2.z}; }
Vec3 vec_subtract(const Vec3& v1, const Vec3& v2) { return {v1.x - v2.x, v1.y - v2.y, v1.z - v2.z}; }
Vec3 vec_scale(const Vec3& v, double s) { return {v.x * s, v.y * s, v.z * s}; }
double vec_dot(const Vec3& v1, const Vec3& v2) { return v1.x * v2.x + v1.y * v2.y + v1.z * v2.z; }
double vec_length(const Vec3& v) { return std::sqrt(vec_dot(v, v)); }
Vec3 vec_normalize(const Vec3& v) { double m = vec_length(v); return m > 1e-8 ? vec_scale(v, 1.0 / m) : Vec3{0,0,0}; }
Vec3 vec_reflect(const Vec3& v, const Vec3& normal) { return vec_subtract(v, vec_scale(normal, 2 * vec_dot(v, normal))); }
Vec3 vec_cross(const Vec3& v1, const Vec3& v2) { return {v1.y * v2.z - v1.z * v2.y, v1.z * v2.x - v1.x * v2.z, v1.x * v2.y - v1.y * v2.x}; }

// --- Color Math ---
Color color_add(const Color& c1, const Color& c2) { return {c1.r + c2.r, c1.g + c2.g, c1.b + c2.b}; }
Color color_scale(const Color& c, double s) { return {c.r * s, c.g * s, c.b * s}; }
Color color_multiply(const Color& c1, const Color& c2) { return {c1.r * c2.r, c1.g * c2.g, c1.b * c2.b}; }


// --- PRNG ---
uint32_t prng_seed = 1;
void reset_prng_for_tile(int x, int y) { prng_seed = y * 1600 + x + 1; }
double random_double() {
    prng_seed = (prng_seed * 1664525 + 1013904223);
    return static_cast<double>(prng_seed) / 4294967296.0;
}
Vec3 random_in_unit_sphere() {
    while (true) {
        Vec3 p = {(random_double() * 2.0 - 1.0), (random_double() * 2.0 - 1.0), (random_double() * 2.0 - 1.0)};
        if (vec_dot(p, p) < 1.0) return p;
    }
}
Vec3 random_in_unit_disk() {
    while (true) {
        Vec3 p = {random_double() * 2.0 - 1.0, random_double() * 2.0 - 1.0, 0};
        if (vec_dot(p, p) < 1.0) return p;
    }
}
Vec3 random_unit_vector() { return vec_normalize(random_in_unit_sphere()); }

// Schlick's approximation for reflectance
double reflectance(double cosine, double ref_idx) {
    auto r0 = (1 - ref_idx) / (1 + ref_idx);
    r0 = r0 * r0;
    return r0 + (1 - r0) * pow((1 - cosine), 5);
}

// --- Scene Objects ---
struct Material {
    Color albedo = {200, 200, 200}; Color emissive = {0, 0, 0};
    double metalness = 0.0; double roughness = 0.0;
    double ior = 1.5; double transparency = 0.0;
};
struct HitRecord {
    double dist = std::numeric_limits<double>::infinity();
    Vec3 point; Vec3 normal; bool front_face;
    const Material* material = nullptr;
    void set_face_normal(const Ray& r, const Vec3& outward_normal) {
        front_face = vec_dot(r.direction, outward_normal) < 0;
        normal = front_face ? outward_normal : vec_scale(outward_normal, -1);
    }
};
struct Sphere {
    Vec3 center; double radius; Material material;
    bool intersect(const Ray& ray, double t_min, double t_max, HitRecord& rec) const {
        Vec3 oc = vec_subtract(ray.origin, center);
        auto a = vec_dot(ray.direction, ray.direction);
        auto half_b = vec_dot(oc, ray.direction);
        auto c = vec_dot(oc, oc) - radius * radius;
        auto discriminant = half_b * half_b - a * c;
        if (discriminant < 0) return false;
        auto sqrtd = std::sqrt(discriminant);
        auto root = (-half_b - sqrtd) / a;
        if (root < t_min || t_max < root) {
            root = (-half_b + sqrtd) / a;
            if (root < t_min || t_max < root) return false;
        }
        rec.dist = root;
        rec.point = vec_add(ray.origin, vec_scale(ray.direction, root));
        Vec3 outward_normal = vec_scale(vec_subtract(rec.point, center), 1.0 / radius);
        rec.set_face_normal(ray, outward_normal);
        rec.material = &material;
        return true;
    }
};
struct Rect {
    Vec3 p0, p1, p2, p3; Vec3 normal; Material material;
    bool intersect(const Ray& ray, double t_min, double t_max, HitRecord& rec) const {
         double denom = vec_dot(normal, ray.direction);
        if (std::abs(denom) > 1e-6) {
            double t = vec_dot(vec_subtract(p0, ray.origin), normal) / denom;
            if (t > t_min && t < t_max) {
                Vec3 hit_point = vec_add(ray.origin, vec_scale(ray.direction, t));
                Vec3 v0 = vec_subtract(p1, p0); Vec3 v1 = vec_subtract(p3, p0);
                Vec3 v2 = vec_subtract(hit_point, p0);
                double dot00 = vec_dot(v0, v0); double dot01 = vec_dot(v0, v1);
                double dot02 = vec_dot(v0, v2); double dot11 = vec_dot(v1, v1);
                double dot12 = vec_dot(v1, v2);
                double invDenom = 1.0 / (dot00 * dot11 - dot01 * dot01);
                double u = (dot11 * dot02 - dot01 * dot12) * invDenom;
                double v = (dot00 * dot12 - dot01 * dot02) * invDenom;
                if ((u >= 0) && (v >= 0) && (u <= 1) && (v <= 1)) {
                    rec.dist = t; rec.point = hit_point;
                    rec.set_face_normal(ray, normal);
                    rec.material = &material;
                    return true;
                }
            }
        }
        return false;
    }
};
struct Scene {
    Vec3 cam_origin = {0, 0, -25};
    Color background = {15, 15, 20};
    std::vector<Sphere> spheres;
    std::vector<Rect> rects;
};

// --- Main Path Tracing Logic ---
Color trace(Ray r, const Scene& scene, int maxDepth) {
    Color accumulated_color = {0, 0, 0};
    Color attenuation = {255, 255, 255};
    for (int depth = 0; depth < maxDepth; ++depth) {
        HitRecord rec;
        bool hit_anything = false;
        double closest_so_far = std::numeric_limits<double>::infinity();
        for (const auto& sphere : scene.spheres) {
            if (sphere.intersect(r, 0.001, closest_so_far, rec)) { hit_anything = true; closest_so_far = rec.dist; }
        }
        for (const auto& rect : scene.rects) {
            if (rect.intersect(r, 0.001, closest_so_far, rec)) { hit_anything = true; closest_so_far = rec.dist; }
        }

        if (hit_anything) {
            Color emitted = rec.material->emissive;
            accumulated_color = color_add(accumulated_color, color_multiply(emitted, color_scale(attenuation, 1.0/255.0)));
            
            Vec3 scatter_direction;
            Color surface_albedo = rec.material->albedo;
            
            if (rec.material->transparency > random_double()) {
                double refraction_ratio = rec.front_face ? (1.0 / rec.material->ior) : rec.material->ior;
                Vec3 unit_direction = vec_normalize(r.direction);
                double cos_theta = std::min(vec_dot(vec_scale(unit_direction, -1), rec.normal), 1.0);
                double sin_theta = std::sqrt(1.0 - cos_theta*cos_theta);

                bool cannot_refract = refraction_ratio * sin_theta > 1.0;
                if (cannot_refract || reflectance(cos_theta, refraction_ratio) > random_double()) {
                    scatter_direction = vec_reflect(unit_direction, rec.normal);
                } else {
                    Vec3 r_out_perp = vec_scale(vec_add(unit_direction, vec_scale(rec.normal, cos_theta)), refraction_ratio);
                    Vec3 r_out_parallel = vec_scale(rec.normal, -sqrt(std::max(0.0, 1.0 - vec_dot(r_out_perp, r_out_perp))));
                    scatter_direction = vec_add(r_out_perp, r_out_parallel);
                }
            } else if (rec.material->metalness > random_double()) {
                Vec3 reflected = vec_reflect(vec_normalize(r.direction), rec.normal);
                scatter_direction = vec_add(reflected, vec_scale(random_in_unit_sphere(), rec.material->roughness));
                if (vec_dot(scatter_direction, rec.normal) <= 0) { break; } 
            } else {
                scatter_direction = vec_add(rec.normal, random_unit_vector());
                if (vec_length(scatter_direction) < 1e-8) { scatter_direction = rec.normal; }
            }
            
            r = {vec_add(rec.point, vec_scale(rec.normal, 1e-4)), vec_normalize(scatter_direction)};
            attenuation = color_multiply(attenuation, color_scale(surface_albedo, 1.0/255.0));
        } else {
            accumulated_color = color_add(accumulated_color, color_multiply(scene.background, color_scale(attenuation, 1.0/255.0)));
            break;
        }
    }
    return accumulated_color;
}

// --- Global scene object ---
Scene global_scene;
bool scene_initialized = false;

// --- Definitive Scene ---
void create_demanding_scene() {
    Material mat_white{{200, 200, 200}};
    Material mat_red{{220, 50, 50}};
    Material mat_green{{50, 220, 50}};
    Material mat_light{{0,0,0}, {1500, 1500, 1500}};
    
    Material mat_glass{{255,255,255}};
    mat_glass.transparency = 1.0;
    mat_glass.ior = 1.5;

    Material mat_metal{{220, 220, 220}};
    mat_metal.metalness = 1.0;
    mat_metal.roughness = 0.05;

    Material mat_gold{{220, 180, 50}};
    mat_gold.metalness = 1.0;
    mat_gold.roughness = 0.15;

    Material mat_floor{{200, 200, 200}};
    mat_floor.metalness = 0.2;
    mat_floor.roughness = 0.3;
    
    double room_dim = 30.0;
    global_scene.rects.push_back(Rect{{-room_dim, -room_dim, room_dim}, {room_dim, -room_dim, room_dim}, {room_dim, -room_dim, -room_dim}, {-room_dim, -room_dim, -room_dim}, {0, 1, 0}, mat_floor});
    global_scene.rects.push_back(Rect{{-room_dim, room_dim, room_dim}, {room_dim, room_dim, room_dim}, {room_dim, room_dim, -room_dim}, {-room_dim, room_dim, -room_dim}, {0, -1, 0}, mat_white});
    global_scene.rects.push_back(Rect{{-room_dim, -room_dim, room_dim}, {room_dim, -room_dim, room_dim}, {room_dim, room_dim, room_dim}, {-room_dim, room_dim, room_dim}, {0, 0, -1}, mat_white});
    global_scene.rects.push_back(Rect{{-room_dim, -room_dim, -room_dim}, {-room_dim, -room_dim, room_dim}, {-room_dim, room_dim, room_dim}, {-room_dim, room_dim, -room_dim}, {1, 0, 0}, mat_red});
    global_scene.rects.push_back(Rect{{room_dim, -room_dim, -room_dim}, {room_dim, -room_dim, room_dim}, {room_dim, room_dim, room_dim}, {room_dim, room_dim, -room_dim}, {-1, 0, 0}, mat_green});
    global_scene.rects.push_back(Rect{{-room_dim, -room_dim, -room_dim}, {room_dim, -room_dim, -room_dim}, {room_dim, room_dim, -room_dim}, {-room_dim, room_dim, -room_dim}, {0, 0, 1}, mat_white});

    double light_size = 8.0; 
    global_scene.rects.push_back(Rect{{-light_size, room_dim - 0.1, -light_size}, {light_size, room_dim - 0.1, -light_size}, {light_size, room_dim - 0.1, light_size}, {-light_size, room_dim - 0.1, light_size}, {0,-1,0}, mat_light});

    // --- 45 Hand-Placed, Chaotic Spheres As Requested ---

    // 15 Glass Spheres
    global_scene.spheres.push_back({ {0, -2, -5}, 2.5, mat_glass });
    global_scene.spheres.push_back({ {-8, 8, 2}, 1.8, mat_glass });
    global_scene.spheres.push_back({ {7, -5, 6}, 1.2, mat_glass });
    global_scene.spheres.push_back({ {10, 2, -10}, 2.0, mat_glass });
    global_scene.spheres.push_back({ {-11, -10, 4}, 1.5, mat_glass });
    global_scene.spheres.push_back({ {2, 9, 8}, 1.0, mat_glass });
    global_scene.spheres.push_back({ {-5, 5, 5}, 1.3, mat_glass });
    global_scene.spheres.push_back({ {0, 10, 0}, 2.8, mat_glass });
    global_scene.spheres.push_back({ {12, -12, -8}, 1.6, mat_glass });
    global_scene.spheres.push_back({ {-9, 1, 10}, 1.1, mat_glass });
    global_scene.spheres.push_back({ {4, -9, -4}, 1.9, mat_glass });
    global_scene.spheres.push_back({ {-2, -10, 7}, 1.4, mat_glass });
    global_scene.spheres.push_back({ {8, 1, -1}, 0.8, mat_glass });
    global_scene.spheres.push_back({ {-1, 3, 3}, 1.0, mat_glass });
    global_scene.spheres.push_back({ {6, 6, -6}, 1.7, mat_glass });

    // 15 Gold Spheres
    global_scene.spheres.push_back({ {5, 0, 0}, 2.0, mat_gold });
    global_scene.spheres.push_back({ {-10, -9, -3}, 1.5, mat_gold });
    global_scene.spheres.push_back({ {8, -8, 8}, 1.0, mat_gold });
    global_scene.spheres.push_back({ {-3, 7, -9}, 2.2, mat_gold });
    global_scene.spheres.push_back({ {11, 11, 2}, 1.3, mat_gold });
    global_scene.spheres.push_back({ {-7, 0, 7}, 1.8, mat_gold });
    global_scene.spheres.push_back({ {3, -6, 10}, 1.1, mat_gold });
    global_scene.spheres.push_back({ {-9, 6, -1}, 1.6, mat_gold });
    global_scene.spheres.push_back({ {1, 1, 11}, 1.4, mat_gold });
    global_scene.spheres.push_back({ {9, -3, -7}, 2.1, mat_gold });
    global_scene.spheres.push_back({ {-6, -6, -6}, 1.2, mat_gold });
    global_scene.spheres.push_back({ {2, 2, 2}, 0.9, mat_gold });
    global_scene.spheres.push_back({ {10, 5, 5}, 1.5, mat_gold });
    global_scene.spheres.push_back({ {-4, -4, 12}, 1.7, mat_gold });
    global_scene.spheres.push_back({ {7, 9, -2}, 1.0, mat_gold });

    // 15 Aluminum Metal Spheres
    global_scene.spheres.push_back({ {-5, -8, 8}, 2.2, mat_metal });
    global_scene.spheres.push_back({ {9, 9, 9}, 1.0, mat_metal });
    global_scene.spheres.push_back({ {-2, 4, -8}, 1.8, mat_metal });
    global_scene.spheres.push_back({ {6, -10, 1}, 1.3, mat_metal });
    global_scene.spheres.push_back({ {-12, 3, 3}, 2.0, mat_metal });
    global_scene.spheres.push_back({ {1, 7, -4}, 1.5, mat_metal });
    global_scene.spheres.push_back({ {9, -9, 0}, 1.1, mat_metal });
    global_scene.spheres.push_back({ {-7, -2, -10}, 1.9, mat_metal });
    global_scene.spheres.push_back({ {5, 12, 4}, 1.2, mat_metal });
    global_scene.spheres.push_back({ {-10, 10, -10}, 2.4, mat_metal });
    global_scene.spheres.push_back({ {3, -3, 3}, 1.0, mat_metal });
    global_scene.spheres.push_back({ {8, 4, 8}, 1.6, mat_metal });
    global_scene.spheres.push_back({ {-6, 11, -5}, 1.4, mat_metal });
    global_scene.spheres.push_back({ {11, -1, 6}, 1.8, mat_metal });
    global_scene.spheres.push_back({ {-3, -7, -1}, 2.0, mat_metal });
}

// --- Main Exported Functions ---
extern "C" {
    EMSCRIPTEN_KEEPALIVE
    void initialize_scene() {
        if (!scene_initialized) { create_demanding_scene(); scene_initialized = true; }
    }

    EMSCRIPTEN_KEEPALIVE
    uint8_t* render_tile(int tileX, int tileY, int tileSize, int canvasWidth, int canvasHeight, const char* scene_json_str, int samplesPerPixel, int maxDepth) {
        size_t bufferSize = tileSize * tileSize * 4;
        uint8_t* pixelData = (uint8_t*)malloc(bufferSize);
        Vec3 lookfrom = global_scene.cam_origin; Vec3 lookat = {0, 0, 0}; Vec3 vup = {0, 1, 0};
        
        double vfov = 100.0; 
        
        double aspect_ratio = static_cast<double>(canvasWidth) / canvasHeight;
        double aperture = 0.05; double focus_dist = vec_length(vec_subtract(lookfrom, lookat));
        auto theta = vfov * M_PI / 180.0; auto h = tan(theta / 2.0);
        auto viewport_height = 2.0 * h; auto viewport_width = aspect_ratio * viewport_height;
        auto w = vec_normalize(vec_subtract(lookfrom, lookat));
        auto u = vec_normalize(vec_cross(vup, w));
        auto v = vec_cross(w, u);
        Vec3 horizontal = vec_scale(u, viewport_width * focus_dist);
        Vec3 vertical = vec_scale(v, viewport_height * focus_dist);
        Vec3 lower_left_corner = vec_subtract(lookfrom, vec_add(vec_add(vec_scale(horizontal, 0.5), vec_scale(vertical, 0.5)), vec_scale(w, focus_dist)));
        double lens_radius = aperture / 2.0;

        for (int yOffset = 0; yOffset < tileSize; ++yOffset) {
            int y = tileY + yOffset;
            for (int xOffset = 0; xOffset < tileSize; ++xOffset) {
                int x = tileX + xOffset;
                reset_prng_for_tile(x, y);
                Color totalColor = {0, 0, 0};
                for (int s = 0; s < samplesPerPixel; ++s) {
                    double camX = (static_cast<double>(x) + random_double()) / (canvasWidth - 1);
                    double camY = 1.0 - (static_cast<double>(y) + random_double()) / (canvasHeight - 1);
                    Vec3 rd = vec_scale(random_in_unit_disk(), lens_radius);
                    Vec3 offset = vec_add(vec_scale(u, rd.x), vec_scale(v, rd.y));
                    Vec3 ray_origin = vec_add(lookfrom, offset);
                    Vec3 point_on_viewport = vec_add(lower_left_corner, vec_add(vec_scale(horizontal, camX), vec_scale(vertical, camY)));
                    Vec3 ray_direction = vec_normalize(vec_subtract(point_on_viewport, ray_origin));
                    Ray ray = {ray_origin, ray_direction};
                    totalColor = color_add(totalColor, trace(ray, global_scene, maxDepth));
                }
                double scale = 1.0 / samplesPerPixel;
                size_t index = (yOffset * tileSize + xOffset) * 4;
                pixelData[index] = static_cast<uint8_t>(std::clamp(std::sqrt(totalColor.r * scale / 255.0) * 255.0, 0.0, 255.0));
                pixelData[index+1] = static_cast<uint8_t>(std::clamp(std::sqrt(totalColor.g * scale / 255.0) * 255.0, 0.0, 255.0));
                pixelData[index+2] = static_cast<uint8_t>(std::clamp(std::sqrt(totalColor.b * scale / 255.0) * 255.0, 0.0, 255.0));
                pixelData[index+3] = 255;
            }
        }
        return pixelData;
    }
    
    EMSCRIPTEN_KEEPALIVE 
    void free_memory(void* ptr) { 
        free(ptr); 
    }
}