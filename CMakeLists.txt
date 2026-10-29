cmake_minimum_required(VERSION 3.16)
project(multiplayer_server VERSION 1.0.0 LANGUAGES CXX)

find_package(Boost 1.74 REQUIRED)
find_package(nlohmann_json 3.10 REQUIRED)
find_package(Threads REQUIRED)

add_executable(multiplayer_server server.cpp)
target_compile_features(multiplayer_server PRIVATE cxx_std_17)
target_include_directories(multiplayer_server SYSTEM PRIVATE ${Boost_INCLUDE_DIRS})
target_compile_definitions(multiplayer_server PRIVATE
    BOOST_ERROR_CODE_HEADER_ONLY BOOST_ALL_NO_LIB)
target_link_libraries(multiplayer_server PRIVATE nlohmann_json::nlohmann_json Threads::Threads)
if(WIN32)
    target_compile_definitions(multiplayer_server PRIVATE _WIN32_WINNT=0x0601 WIN32_LEAN_AND_MEAN NOMINMAX)
    target_link_libraries(multiplayer_server PRIVATE ws2_32 mswsock)
endif()
if(MSVC)
    target_compile_options(multiplayer_server PRIVATE /W4 /permissive- /utf-8)
else()
    target_compile_options(multiplayer_server PRIVATE -Wall -Wextra -Wpedantic)
endif()

include(CTest)
if(BUILD_TESTING)
    find_program(NODE_EXECUTABLE NAMES node node.exe)
    if(NODE_EXECUTABLE)
        add_test(NAME websocket_integration
            COMMAND "${NODE_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tests/integration.mjs"
                    "$<TARGET_FILE:multiplayer_server>")
        set_tests_properties(websocket_integration PROPERTIES TIMEOUT 60)
    endif()
endif()
