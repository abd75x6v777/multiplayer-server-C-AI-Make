// C++17 replacement for the supplied Python WebSocket relay.
#include <boost/asio.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/websocket.hpp>
#include <nlohmann/json.hpp>

#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>

namespace net = boost::asio;
namespace beast = boost::beast;
namespace http = beast::http;
namespace websocket = beast::websocket;
using tcp = net::ip::tcp;
using Json = nlohmann::json;
using Message = std::shared_ptr<const std::string>;

constexpr std::size_t MAX_MESSAGE_BYTES = 1024 * 1024;
constexpr std::size_t MAX_PENDING_BYTES = 4 * 1024 * 1024;

class Session;

// Accessed exclusively by the single io_context thread, like asyncio.
class Players {
public:
    std::string join(const std::shared_ptr<Session>& session);
    void leave(const std::string& id);
    void broadcast(const Json& data, const std::string& sender);

private:
    std::uint64_t next_id_ = 1;
    std::unordered_map<std::string, std::weak_ptr<Session>> clients_;
};

class Session : public std::enable_shared_from_this<Session> {
public:
    Session(tcp::socket socket, Players& players)
        : ws_(std::move(socket)), players_(players) {}

    void run() {
        // Read HTTP first so health checks and WebSockets share Render's port.
        beast::get_lowest_layer(ws_).expires_after(std::chrono::seconds(30));
        request_.body_limit(1024);
        request_.header_limit(8192);
        http::async_read(ws_.next_layer(), buffer_, request_,
            [self = shared_from_this()](beast::error_code ec, std::size_t) {
                self->on_http(ec);
            });
    }

    void send(Message message) {
        // Posting also prevents a failed recipient from mutating the player
        // registry recursively while a broadcast is iterating over it.
        net::post(ws_.get_executor(),
            [self = shared_from_this(), message = std::move(message)] {
                if (self->stopped_) return;
                if (message->size() > MAX_PENDING_BYTES - self->pending_bytes_) {
                    std::cerr << "Slow client disconnected: " << self->id_ << '\n';
                    self->stop();
                    return;
                }
                const bool writing = !self->outbox_.empty();
                self->pending_bytes_ += message->size();
                self->outbox_.push_back(message);
                if (!writing) self->write();
            });
    }

private:
    websocket::stream<beast::tcp_stream> ws_;
    Players& players_;
    beast::flat_buffer buffer_;
    http::request_parser<http::string_body> request_;
    std::string id_;
    std::deque<Message> outbox_;
    std::size_t pending_bytes_ = 0;
    bool stopped_ = false;

    void on_http(beast::error_code ec) {
        if (ec) return stop();
        const auto& request = request_.get();
        if (websocket::is_upgrade(request)) {
            beast::get_lowest_layer(ws_).expires_never();
            auto timeout = websocket::stream_base::timeout::suggested(
                beast::role_type::server);
            timeout.handshake_timeout = std::chrono::seconds(30);
            timeout.idle_timeout = std::chrono::seconds(60);
            timeout.keep_alive_pings = true;
            ws_.set_option(timeout);
            ws_.read_message_max(MAX_MESSAGE_BYTES);
            ws_.async_accept(request,
                [self = shared_from_this()](beast::error_code error) {
                    if (error) return self->stop();
                    self->id_ = self->players_.join(self);
                    std::cout << "Player connected: " << self->id_ << '\n';
                    self->read();
                });
            return;
        }

        const bool healthy = request.method() == http::verb::get &&
            (request.target() == "/" || request.target() == "/health");
        auto response = std::make_shared<http::response<http::string_body>>(
            healthy ? http::status::ok : http::status::not_found,
            request.version());
        response->set(http::field::content_type, "application/json");
        response->keep_alive(false);
        response->body() = healthy ? "{\"status\":\"ok\"}" : "{\"error\":\"not_found\"}";
        response->prepare_payload();
        http::async_write(ws_.next_layer(), *response,
            [self = shared_from_this(), response](beast::error_code, std::size_t) {
                self->stop();
            });
    }

    void read() {
        if (stopped_) return;
        ws_.async_read(buffer_,
            [self = shared_from_this()](beast::error_code ec, std::size_t) {
                self->on_read(ec);
            });
    }

    void on_read(beast::error_code ec) {
        if (ec) return stop();
        if (stopped_) return;
        const auto payload = beast::buffers_to_string(buffer_.data());
        buffer_.consume(buffer_.size());
        // Python json.loads accepts both text and UTF-8 binary messages.
        auto data = Json::parse(payload, nullptr, false);
        if (data.is_object()) {
            // Never trust a client-supplied player_id.
            data["player_id"] = id_;
            players_.broadcast(data, id_);
        } else {
            // Invalid JSON/arrays/scalars are ignored without disconnecting.
            std::cerr << "Ignored invalid JSON object from player " << id_ << '\n';
        }
        read();
    }

    void write() {
        if (stopped_) return;
        // Retain the payload until completion, including cancellation.
        auto message = outbox_.front();
        ws_.text(true);
        ws_.async_write(net::buffer(*message),
            [self = shared_from_this(), message](beast::error_code ec, std::size_t) {
                if (ec) return self->stop();
                if (self->stopped_) return;
                self->pending_bytes_ -= message->size();
                self->outbox_.pop_front();
                if (!self->outbox_.empty()) self->write();
            });
    }

    void stop() {
        if (stopped_) return;
        stopped_ = true;
        beast::error_code ignored;
        auto& socket = beast::get_lowest_layer(ws_).socket();
        socket.cancel(ignored);
        socket.shutdown(tcp::socket::shutdown_both, ignored);
        socket.close(ignored);
        if (!id_.empty()) players_.leave(id_);
    }
};

std::string Players::join(const std::shared_ptr<Session>& session) {
    // IDs stay strings, as in the Python protocol. They identify a connection,
    // not a persistent account, and change when a player reconnects.
    if (next_id_ == std::numeric_limits<std::uint64_t>::max()) {
        throw std::overflow_error("Player ID space exhausted");
    }
    auto id = std::to_string(next_id_++);
    clients_.emplace(id, session);
    return id;
}

void Players::leave(const std::string& id) {
    if (clients_.erase(id) == 0) return;
    std::cout << "Player disconnected: " << id << '\n';
    broadcast(Json{{"action", "disconnect"}, {"player_id", id}}, id);
}

void Players::broadcast(const Json& data, const std::string& sender) {
    auto message = std::make_shared<const std::string>(data.dump());
    for (const auto& entry : clients_) {
        if (entry.first != sender) {
            if (auto client = entry.second.lock()) client->send(message);
        }
    }
}

class Listener : public std::enable_shared_from_this<Listener> {
public:
    Listener(net::io_context& context, unsigned short port, Players& players)
        : acceptor_(context), players_(players) {
        const tcp::endpoint endpoint{net::ip::make_address("0.0.0.0"), port};
        acceptor_.open(endpoint.protocol());
        acceptor_.set_option(net::socket_base::reuse_address(true));
        acceptor_.bind(endpoint);
        acceptor_.listen(net::socket_base::max_listen_connections);
    }

    void run() {
        acceptor_.async_accept(
            [self = shared_from_this()](beast::error_code ec, tcp::socket socket) {
                if (!ec) {
                    std::make_shared<Session>(std::move(socket), self->players_)->run();
                } else if (ec == net::error::operation_aborted) {
                    return;
                } else {
                    std::cerr << "Accept error: " << ec.message() << '\n';
                }
                self->run();
            });
    }

private:
    tcp::acceptor acceptor_;
    Players& players_;
};

unsigned short configured_port() {
    const char* value = std::getenv("PORT");
    if (!value) return 8080;
    const std::string text(value);
    if (text.empty() || text.find_first_not_of("0123456789") != std::string::npos) {
        throw std::runtime_error("PORT must be an integer from 1 to 65535");
    }
    const auto port = std::stoul(text);
    if (port == 0 || port > 65535) {
        throw std::runtime_error("PORT must be an integer from 1 to 65535");
    }
    return static_cast<unsigned short>(port);
}

int main() {
    try {
        std::cout << std::unitbuf;
        const auto port = configured_port();
        // Keep this single-threaded: all registry/queue operations are serialized.
        net::io_context context{1};
        Players players;
        auto listener = std::make_shared<Listener>(context, port, players);
        listener->run();
        net::signal_set signals(context, SIGINT, SIGTERM);
        signals.async_wait([&context](beast::error_code, int) { context.stop(); });
        std::cout << "Listening on 0.0.0.0:" << port << '\n';
        context.run();
        return EXIT_SUCCESS;
    } catch (const std::exception& error) {
        std::cerr << "Server error: " << error.what() << '\n';
        return EXIT_FAILURE;
    }
}
